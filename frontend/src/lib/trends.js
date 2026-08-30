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
import { dailyLoad } from './session-load.js'

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
 *
 * `fill` says what a day with no row means, and the two series disagree about it. A band
 * records a strain every day, so a missing day is a gap in the data and averaging over the
 * days present is right. Lifting is intermittent by design: a day with no session is a
 * genuine zero, and averaging over training days only would rate a three-day week and a
 * six-day week the same. With fill the mean is over the calendar — average daily load, rest
 * days included, which is the usual formulation — and coverage becomes a question of how far
 * back the history reaches rather than how many days in it hold a number.
 */
export function loadBalance(metrics, { now = Date.now(), value = m => m.strain, fill = false } = {}) {
  if (!Array.isArray(metrics)) return null
  const rows = metrics.filter(m => value(m) != null)
  // "The last n days" means n of them: today and the n-1 before it. Off by one it is not,
  // once `fill` starts dividing by the window length — an 8-day sum over a 7-day span
  // reads as a heavier week than it was.
  const inWindow = n => {
    const since = now - (n - 1) * DAY
    return rows.filter(m => dayMs(m.d) >= since && dayMs(m.d) <= now)
  }
  const chronicDays = inWindow(CHRONIC_DAYS)
  const acuteDays = inWindow(ACUTE_DAYS)
  const first = rows.length ? Math.min(...rows.map(m => dayMs(m.d))) : null
  const thin = { ok: false, have: chronicDays.length, need: Math.ceil(CHRONIC_DAYS * 0.6) }
  if (fill) {
    // Half a chronic window of history is not a chronic baseline, however many sessions
    // happen to sit in it.
    if (first == null || first > now - (CHRONIC_DAYS - 1) * DAY) return thin
  } else if (chronicDays.length < CHRONIC_DAYS * 0.6 || acuteDays.length < ACUTE_DAYS * 0.5) {
    // Coverage, not row count: a month holding six strain values would otherwise pass.
    return thin
  }
  const avg = (rowsIn, span) => {
    const total = rowsIn.reduce((a, m) => a + value(m), 0)
    return fill ? total / span : mean(rowsIn.map(value))
  }
  const acute = avg(acuteDays, ACUTE_DAYS)
  const chronic = avg(chronicDays, CHRONIC_DAYS)
  if (!chronic) return thin
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
export function weeklyStrain(metrics, { weeks = 8, now = Date.now(), value = m => m.strain } = {}) {
  if (!Array.isArray(metrics)) return []
  const since = now - weeks * 7 * DAY
  const by = new Map()
  for (const m of metrics) {
    const v = value(m)
    if (v == null || dayMs(m.d) < since) continue
    const k = weekKey(m.d)
    const cur = by.get(k) || { week: k, total: 0, days: 0, from: m.d }
    cur.total = round1(cur.total + v)
    cur.days++
    cur.to = m.d
    by.set(k, cur)
  }
  return [...by.values()].sort((a, b) => (a.from < b.from ? -1 : 1))
}

/* -------------------------------------------------------------- lifting -- */

/**
 * The same load treatment, run over the barbell half of the training.
 *
 * Whoop's strain series only holds the sessions Whoop scored. A lifter's week lands in it
 * as a flat line, so "Training load" was quietly describing their cardio and calling it
 * their training. session-load.js gives a lifting session a load of its own; this puts it
 * through the same acute-against-chronic and week-by-week reads.
 *
 * The two are reported side by side and never summed. An sRPE arbitrary unit is not a
 * Whoop strain point, a kilogram-rep is neither, and adding them would produce a number
 * whose meaning changes with whatever mix of training the week happened to hold.
 */
export function liftingLoad(S, { now = Date.now(), weeks = 8 } = {}) {
  const series = dailyLoad((S && S.workouts) || [], { now })
  if (!series.basis || series.days.length < 2) {
    return { ok: false, basis: series.basis, days: series.days.length }
  }
  const value = m => m.load
  return {
    ok: true,
    basis: series.basis, unit: series.unit,
    // How close the profile came to the better basis, so the screen can say what switching
    // the effort column on would buy rather than leaving volume load looking like the only
    // way to measure a session.
    rated: series.rated, sessions: series.sessions,
    // fill: a rest day is a day of no load, not a missing reading. Without it a week of
    // three heavy sessions and a week of six would average out to the same number.
    balance: loadBalance(series.days, { now, value, fill: true }),
    weekly: weeklyStrain(series.days, { weeks, now, value }),
  }
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
  const weeks = Math.max(4, Math.ceil(days / 7))
  // The lifting half stands on its own history, so a profile with no band at all still gets
  // a load read. Only a profile with neither has nothing to show.
  const lifting = liftingLoad(S, { now, weeks })
  if (!metrics.length && !lifting.ok) return { ok: false, missing: ['metrics', 'workouts'] }
  return {
    ok: true,
    mix: stageMix(metrics, { days, now }),
    shortfall: sleepShortfall(metrics, { days, now }),
    load: loadBalance(metrics, { now }),
    weekly: weeklyStrain(metrics, { weeks, now }),
    lifting,
  }
}
