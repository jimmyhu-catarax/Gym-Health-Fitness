// How recovered you were this morning, shown where you decide what to lift.
//
// This is the join the whole merge is for. Hevy knows what you lifted; Whoop knows how you
// slept. Neither knows the other, so the decision they both feed — what to do today — gets
// made with half the information. The Stats cards look backwards at that; this looks at it
// while it still matters.
//
// **It reports, it does not prescribe.** No "take it easy", no suggested deload, no adjusted
// target. Two reasons, and the second is the one that matters:
//
//   The app already has a progression engine, and it decides load from logged performance —
//   reps made, reps missed, stalls. Bolting a second opinion onto the front of that gives
//   two systems authority over the same number, and when they disagree the user cannot tell
//   which one moved their weights. One hand on the wheel.
//
//   "Train lighter today" is training advice. It reads as a recommendation from software that
//   has never seen you train, derived from one number with a documented error bar. Whoop is
//   willing to make that call; this app knows the score, shows the score, and lets the person
//   holding the barbell make it.
//
// The staleness gate is the other real decision here. A recovery score describes the morning
// it was computed. Four days later it is a fact about last Tuesday, and putting it next to
// "Start workout" implies it is about today — so past a day old this returns nothing at all
// rather than something misleading but reassuringly present.

import { withComputedRecovery, recoveryZone } from './physiology.js'
import { latestWith, daysAgo, trendOf } from './metrics.js'

/** Past this many days the score is history, not readiness, and is not shown. */
export const FRESH_DAYS = 1

/** What each zone means, in the app's own words rather than Whoop's. */
export const ZONE_NOTE = {
  green: 'Your body is where it usually is, or better.',
  yellow: 'A bit below your normal. Worth knowing, not necessarily worth changing anything.',
  red: 'Well below your own baseline — poor sleep, illness, or the last few sessions catching up.',
}

/**
 * The readiness context for a day, or null when there is nothing honest to say.
 *
 * Returns null — rather than an empty shell the UI has to interpret — in every case where a
 * number would mislead: no metrics at all, no recovery on any day, or a most-recent score too
 * old to describe this morning.
 *
 * @returns {{pct:number, zone:string, d:string, stale:number, src:string,
 *            note:string, trend:object|null}|null}
 */
export function readinessFor(S, { now = Date.now(), freshDays = FRESH_DAYS } = {}) {
  const raw = (S && S.metrics) || []
  if (!raw.length) return null

  const metrics = withComputedRecovery(raw)
  const day = latestWith(metrics, ['recovery'])
  if (!day || day.recovery == null) return null

  const stale = daysAgo(day.d, now)
  if (stale > freshDays) return null

  const zone = recoveryZone(day.recovery)
  return {
    pct: Math.round(day.recovery),
    zone,
    d: day.d,
    stale,
    src: day.recoverySrc || 'whoop',
    note: ZONE_NOTE[zone],
    // Against your own recent normal, which is the only comparison that means anything —
    // 62% is a good day for one person and a bad one for another.
    trend: trendOf(metrics, 'recovery', { days: 30, now }),
  }
}
