// Where the two halves actually meet.
//
// Hevy knows what you lifted. Whoop knows how you slept and recovered. Neither knows the
// other, and every interesting question lives in the join: did Tuesday's session cost
// Wednesday's recovery, do you lift more on green days than red ones, does a short night
// show up in the numbers on the bar. That is the whole reason for merging the two apps
// rather than running both.
//
// It is also the part where it is easiest to say something untrue, so the constraints here
// are stricter than anywhere else in the codebase:
//
//   **This is description, not inference.** Everything below reports what your own days did.
//   None of it is a significance test and none of it establishes cause. Training hard and
//   sleeping badly are both more likely in a stressful week; the arrow can point either way,
//   or at something neither variable names. The report says so, in those words, on screen.
//
//   **A correlation over a handful of days is noise wearing a number's clothes.** With eight
//   pairs you can pull |r| > 0.5 out of dice. So every statistic carries its n, nothing is
//   reported below MIN_PAIRS, and nothing is called notable below R_NOTABLE.
//
//   **No p-values.** Computing one properly needs a t-distribution this project is not
//   importing a library for, and the normal approximation is optimistic exactly where the
//   samples are small — the dangerous direction. An honest r with an honest n beats a
//   p-value that is wrong in the flattering direction.

import { workoutVolume } from './history.js'
import { withComputedRecovery, recoveryZone } from './physiology.js'

const DAY = 86400000
const round1 = n => Math.round(n * 10) / 10
const round2 = n => Math.round(n * 100) / 100
const dayMs = d => Date.parse(String(d) + 'T12:00:00Z')
// Guarded because `new Date(NaN).toISOString()` throws rather than returning something
// useless, so one unparseable date in stored state would take the whole screen down. State
// persists across versions and survives backup round-trips; it does not get to be trusted.
const isoOf = ms => (isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null)

/** Below this many paired days nothing is reported at all. */
export const MIN_PAIRS = 14
/** Below this |r| a relationship is reported as "nothing much", not as a finding. */
export const R_NOTABLE = 0.3

/** Pearson correlation, or null when the input cannot support one. */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i] }
  const mx = sx / n, my = sy / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  // Zero variance on either side: every value identical, so there is no relationship to
  // measure. Returning 0 would read as "no correlation found", which is a different claim.
  if (dx <= 0 || dy <= 0) return null
  // `|| 0` folds negative zero away. A correlation that rounds to nothing is nothing, and
  // "r=-0" on a card reads as a broken number rather than as an absence of relationship.
  return round2(num / Math.sqrt(dx * dy)) || 0
}

export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * One row per calendar day in the window, carrying both halves.
 *
 * Days are the join key because that is the finest granularity both sides share: a recovery
 * score is a property of a night, not a moment. `nextRecovery` is the following day's score,
 * which is the one a session could plausibly have moved — recovery is measured on waking, so
 * today's score was determined before today's training happened.
 */
export function pairDays(S, { now = Date.now(), days = 90 } = {}) {
  const metrics = withComputedRecovery((S && S.metrics) || [])
  if (!metrics.length) return []
  const byDate = new Map(metrics.map(m => [m.d, m]))

  const trained = new Map()
  for (const w of (S && S.workouts) || []) {
    const cur = trained.get(w.d) || { volume: 0, sets: 0 }
    cur.volume += workoutVolume(w)
    cur.sets += w.entries.reduce((a, e) => a + e.sets.filter(s => s.done).length, 0)
    trained.set(w.d, cur)
  }

  const since = now - days * DAY
  const out = []
  for (const m of metrics) {
    const ms = dayMs(m.d)
    if (!isFinite(ms) || ms < since || ms > now + DAY) continue
    const t = trained.get(m.d)
    const nextD = isoOf(ms + DAY)
    const next = nextD ? byDate.get(nextD) : null
    out.push({
      d: m.d,
      trained: !!t,
      volume: t ? round1(t.volume) : 0,
      sets: t ? t.sets : 0,
      recovery: m.recovery ?? null,
      strain: m.strain ?? null,
      sleepDur: m.sleepDur ?? null,
      hrv: m.hrv ?? null,
      nextRecovery: next && next.recovery != null ? next.recovery : null,
    })
  }
  return out
}

/**
 * What recovery looks like the morning after training, against the morning after rest.
 *
 * Uses `nextRecovery` rather than same-day for the reason above: recovery is scored on
 * waking, so a session cannot have influenced the number already on the board that morning.
 * Comparing same-day would find a relationship pointing backwards in time.
 */
export function recoveryAfterTraining(pairs) {
  const after = pairs.filter(p => p.trained && p.nextRecovery != null).map(p => p.nextRecovery)
  const rest = pairs.filter(p => !p.trained && p.nextRecovery != null).map(p => p.nextRecovery)
  if (after.length < 5 || rest.length < 5) return null
  const a = round1(mean(after)), r = round1(mean(rest))
  return { after: a, rest: r, delta: round1(a - r), nAfter: after.length, nRest: rest.length }
}

/**
 * Training volume grouped by the morning's recovery zone.
 *
 * Only days that were actually trained count. Including rest days would compare "how much do
 * you lift when recovered" against a pile of zeroes and manufacture an enormous effect out of
 * the fact that people rest.
 */
export function volumeByZone(pairs) {
  const groups = { green: [], yellow: [], red: [] }
  for (const p of pairs) {
    if (!p.trained || p.recovery == null || !p.volume) continue
    groups[recoveryZone(p.recovery)].push(p.volume)
  }
  const out = {}
  let total = 0
  for (const k of ['green', 'yellow', 'red']) {
    const n = groups[k].length
    total += n
    out[k] = n ? { mean: round1(mean(groups[k])), n } : null
  }
  return total >= 8 ? out : null
}

/** A correlation between two columns of the paired series, with its n and a plain reading. */
export function relate(pairs, xKey, yKey, { trainedOnly = false } = {}) {
  const rows = pairs.filter(p =>
    p[xKey] != null && p[yKey] != null && (!trainedOnly || (p.trained && p.volume)))
  if (rows.length < MIN_PAIRS) return { ok: false, n: rows.length, need: MIN_PAIRS }
  const r = pearson(rows.map(p => p[xKey]), rows.map(p => p[yKey]))
  if (r == null) return { ok: false, n: rows.length, need: MIN_PAIRS }
  return {
    ok: true, r, n: rows.length,
    notable: Math.abs(r) >= R_NOTABLE,
    direction: r > 0 ? 'up' : 'down',
  }
}

/**
 * Everything the cross-analysis card shows, or a refusal naming what it is short of.
 *
 * `caveat` is not decoration and callers must render it. Every number in here is a
 * description of past days; none of it is evidence that one thing caused another.
 */
export function trainingRecoveryReport(S, { now = Date.now(), days = 90 } = {}) {
  const pairs = pairDays(S, { now, days })
  const usable = pairs.filter(p => p.recovery != null).length
  if (usable < MIN_PAIRS) {
    return { ok: false, missing: 'pairs', have: usable, need: MIN_PAIRS, trainedDays: pairs.filter(p => p.trained).length }
  }
  return {
    ok: true,
    days: pairs.length,
    trainedDays: pairs.filter(p => p.trained).length,
    cost: recoveryAfterTraining(pairs),
    byZone: volumeByZone(pairs),
    strainVsNext: relate(pairs, 'strain', 'nextRecovery'),
    sleepVsVolume: relate(pairs, 'sleepDur', 'volume', { trainedOnly: true }),
    recoveryVsVolume: relate(pairs, 'recovery', 'volume', { trainedOnly: true }),
    caveat: 'These are patterns in your own days, not proof that one caused the other.',
  }
}
