// The two things a single trend line hides.
//
// The Trends chart plots one metric at a time, which answers "is this going up". Two
// questions it cannot answer matter more:
//
//   Sleep composition. Total time asleep can hold perfectly steady while deep sleep drains
//   out of it. The line is flat and the night is getting worse. Only the mix shows that.
//
//   Whether you are ramping. A strain of 14 means nothing alone. Against a fortnight of 9s
//   it is a hard week; against a month of 15s it is a light one. Load is relative to what you
//   have been doing, which is a comparison of two windows and never a single point.
//
// Both are pure functions over `S.metrics`, and both refuse when the window is too thin to
// support the claim — a "mix shift" computed from four nights is noise with a chart attached.

import { weekKey } from './format.js'

const DAY = 86400000
const round1 = n => Math.round(n * 10) / 10
const dayMs = d => Date.parse(String(d) + 'T12:00:00Z')
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/* --------------------------------------------------------------- sleep -- */

export const STAGES = ['deep', 'rem', 'light']

/** A night usable for composition: every stage present and summing to the recorded total. */
const staged = m =>
  STAGES.every(k => m[k] != null) && m.sleepDur > 0 &&
  Math.abs(STAGES.reduce((a, k) => a + m[k], 0) - m.sleepDur) <= 5

/** Nights are thin on the ground — a week off the band is normal — so this floor is low. */
export const MIX_MIN_NIGHTS = 8

/**
 * How the sleep mix sits now, and how it has moved.
 *
 * The window is split in half and compared, rather than fitted, because a fitted slope over
 * ten noisy nights invites more confidence than ten nights can carry. Halves say "more or
 * less than before" and nothing finer, which is the honest resolution here.
 *
 * Minutes *and* percentages, because they answer different questions: 12 fewer minutes of
 * deep sleep inside a shorter night may be the same share, and a share that holds while the
 * night shrinks is still less deep sleep.
 */
export function stageMix(metrics, { days = 30, now = Date.now() } = {}) {
  if (!Array.isArray(metrics)) return null
  const since = now - days * DAY
  const nights = metrics.filter(m => dayMs(m.d) >= since && staged(m))
  if (nights.length < MIX_MIN_NIGHTS) {
    return { ok: false, nights: nights.length, need: MIX_MIN_NIGHTS }
  }

  const avgOf = ns => {
    const total = mean(ns.map(m => m.sleepDur))
    const out = { total: round1(total), nights: ns.length }
    for (const k of STAGES) {
      const min = mean(ns.map(m => m[k]))
      out[k] = { min: round1(min), pct: Math.round((min / total) * 100) }
    }
    return out
  }

  // Split by position, not by date: nights are irregular, and a calendar split can put nine
  // nights on one side and two on the other.
  const half = Math.floor(nights.length / 2)
  const older = avgOf(nights.slice(0, half))
  const newer = avgOf(nights.slice(half))

  const shift = {}
  for (const k of STAGES) {
    shift[k] = { min: round1(newer[k].min - older[k].min), pct: newer[k].pct - older[k].pct }
  }
  return { ok: true, nights: nights.length, avg: avgOf(nights), older, newer, shift }
}

/**
 * Sleep against what Whoop said you needed, per night, over the window.
 *
 * Reported as a nightly shortfall rather than a running total. Cumulative debt only means
 * something if you believe it never clears, and Whoop's own need figure already folds in
 * recent debt — adding our own accumulator on top would double-count it.
 */
export function sleepShortfall(metrics, { days = 30, now = Date.now() } = {}) {
  if (!Array.isArray(metrics)) return null
  const since = now - days * DAY
  const nights = metrics.filter(m => dayMs(m.d) >= since && m.sleepDur > 0 && m.sleepNeed > 0)
  if (!nights.length) return null
  const short = nights.map(m => m.sleepNeed - m.sleepDur)
  return {
    nights: nights.length,
    avg: round1(mean(short)),
    worst: round1(Math.max(...short)),
    met: nights.filter((_, i) => short[i] <= 0).length,
    points: nights.map(m => ({ t: dayMs(m.d), y: round1((m.sleepNeed - m.sleepDur) / 60), d: m.d })),
  }
}

/* -------------------------------------------------------------- strain -- */

export const ACUTE_DAYS = 7
export const CHRONIC_DAYS = 28

/** Bands from the training-load literature, named for what they describe, not what they predict. */
export const LOAD_BANDS = [
  { max: 0.8, key: 'easing', label: 'Easing off' },
  { max: 1.3, key: 'steady', label: 'Steady' },
  { max: Infinity, key: 'ramping', label: 'Ramping up' },
]
export const loadBand = ratio => LOAD_BANDS.find(b => ratio < b.max)

/**
 * This week's training load against the last month's.
 *
 * The acute:chronic workload construct — a rolling short window over a rolling long one —
 * from the training-load literature (Banister's fitness-fatigue lineage; popularised for
 * team sport by Gabbett 2016).
 *
 * **Reported as load balance, never as injury risk, and that is deliberate.** The ratio is
 * genuinely contested: Impellizzeri et al. (2020) show the acute window sits inside the
 * chronic one, so the two are mathematically coupled and correlate even on random data, and
 * the "danger zone" thresholds have not held up on re-analysis. What survives the criticism
 * is the descriptive part — whether this week is heavier than your recent normal — and that
 * is all this returns. No threshold here claims to predict an injury, because it cannot.
 *
 * Requires a full chronic window. A 28-day baseline built from nine days is not a baseline,
 * and the ratio would be dominated by however many days happened to be there.
 */
export function loadBalance(metrics, { now = Date.now() } = {}) {
  if (!Array.isArray(metrics)) return null
  const inWindow = n => {
    const since = now - n * DAY
    return metrics.filter(m => m.strain != null && dayMs(m.d) >= since && dayMs(m.d) <= now)
  }
  const chronicDays = inWindow(CHRONIC_DAYS)
  const acuteDays = inWindow(ACUTE_DAYS)
  // Coverage, not row count: a month holding six strain values would otherwise pass.
  if (chronicDays.length < CHRONIC_DAYS * 0.6 || acuteDays.length < ACUTE_DAYS * 0.5) {
    return { ok: false, have: chronicDays.length, need: Math.ceil(CHRONIC_DAYS * 0.6) }
  }
  const acute = mean(acuteDays.map(m => m.strain))
  const chronic = mean(chronicDays.map(m => m.strain))
  if (!chronic) return { ok: false, have: chronicDays.length, need: Math.ceil(CHRONIC_DAYS * 0.6) }
  const ratio = acute / chronic
  return {
    ok: true,
    acute: round1(acute), chronic: round1(chronic), ratio: Math.round(ratio * 100) / 100,
    band: loadBand(ratio), days: chronicDays.length, acuteDays: acuteDays.length,
  }
}

/**
 * Strain totalled by calendar week.
 *
 * Summed rather than averaged: a week is a training block, and five hard days plus two rest
 * days is a different week from seven moderate ones even where the mean matches. Partial
 * weeks are kept and labelled with their day count so the newest bar is not read as a drop.
 */
export function weeklyStrain(metrics, { weeks = 8, now = Date.now() } = {}) {
  if (!Array.isArray(metrics)) return []
  const since = now - weeks * 7 * DAY
  const by = new Map()
  for (const m of metrics) {
    if (m.strain == null || dayMs(m.d) < since) continue
    const k = weekKey(m.d)
    const cur = by.get(k) || { week: k, total: 0, days: 0, from: m.d }
    cur.total = round1(cur.total + m.strain)
    cur.days++
    cur.to = m.d
    by.set(k, cur)
  }
  return [...by.values()].sort((a, b) => (a.from < b.from ? -1 : 1))
}

/* ---------------------------------------------------------------- all -- */

/**
 * Everything the detail view needs, or a refusal naming what is thin.
 *
 * Each section stands alone: an export with sleep but no strain gets the sleep half rather
 * than nothing, because a partial answer that says which part is missing beats a blank card.
 */
export function trendDetail(S, { now = Date.now(), days = 30 } = {}) {
  const metrics = (S && S.metrics) || []
  if (!metrics.length) return { ok: false, missing: ['metrics'] }
  return {
    ok: true,
    mix: stageMix(metrics, { days, now }),
    shortfall: sleepShortfall(metrics, { days, now }),
    load: loadBalance(metrics, { now }),
    weekly: weeklyStrain(metrics, { weeks: Math.max(4, Math.ceil(days / 7)), now }),
  }
}
