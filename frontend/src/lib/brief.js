// The morning brief — the one place both halves of the app meet.
//
// Home was the lifting app's screen and Stats was the band's, so a person opening this in the
// morning got exactly one of the two answers they came for: what am I lifting today, or how
// did I sleep. The decision they actually make needs both, and it gets made on Home.
//
// **It reports, it does not prescribe.** Same line `readiness.js` draws, for the same reason:
// the progression engine owns load, and a second opinion bolted onto the front of it leaves
// two systems moving the same number with no way to tell which one did. Recovery sits next to
// today's session and says what it is. Nothing here suggests a deload or tells anyone to take
// it easy.
//
// Its real job is deciding what *not* to show. Every number here is a claim about this
// morning, and the band's numbers stop being that quickly:
//
//   recovery — describes the morning it was scored. Yesterday's is a fact about yesterday.
//   sleep    — describes one night. Same.
//   strain   — describes a *completed* day, so the newest complete row is normally yesterday's.
//              One day old is the healthy state here, not staleness.
//
// One day is therefore the gate for all three, but it means "still about now" for two of them
// and "the most recent finished day" for the third. Each is gated on its own: a band worn last
// night but not the night before has fresh sleep and stale strain, and showing the sleep is
// right while showing the strain is not.
//
// The distinction the UI needs and cannot recover afterwards is `has` vs `any`: no band data
// at all is an invitation to import, and band data that has all gone stale is a reminder to
// sync. Blanking both the same way would tell someone who imported last month that the
// feature does not exist.

import { withComputedRecovery, recoveryZone } from './physiology.js'
import { latestWith, daysAgo, trendOf } from './metrics.js'
import { ZONE_NOTE } from './readiness.js'

/** Past this many days a band number describes history, not this morning. */
export const FRESH_DAYS = 1

/** How far back the "vs your own normal" comparison looks. */
export const TREND_DAYS = 30

const fresh = (day, now, freshDays) => day && daysAgo(day.d, now) <= freshDays

/**
 * What the band has to say about today, or nulls where it has nothing honest to say.
 *
 * Never throws on a missing, empty or malformed store — Home renders on first launch, before
 * any import, and a brief that can fail there takes the whole screen with it.
 *
 * @returns {{has:boolean, any:boolean, stale:number|null,
 *            recovery:object|null, sleep:object|null, strain:object|null}}
 */
export function morningBrief(S, { now = Date.now(), freshDays = FRESH_DAYS, days = TREND_DAYS } = {}) {
  const raw = (S && Array.isArray(S.metrics)) ? S.metrics : []
  const none = { has: false, any: false, stale: null, recovery: null, sleep: null, strain: null }
  if (!raw.length) return none

  const metrics = withComputedRecovery(raw)
  const newest = latestWith(metrics)
  if (!newest) return none

  const recDay = latestWith(metrics, ['recovery'])
  const sleepDay = latestWith(metrics, ['sleepDur', 'sleepPerf'])
  const strainDay = latestWith(metrics, ['strain'])

  const recovery = fresh(recDay, now, freshDays) && recDay.recovery != null ? {
    pct: Math.round(recDay.recovery),
    zone: recoveryZone(recDay.recovery),
    note: ZONE_NOTE[recoveryZone(recDay.recovery)],
    d: recDay.d,
    stale: daysAgo(recDay.d, now),
    // A score this app worked out is not the one the band measured, and the UI says so.
    src: recDay.recoverySrc || 'whoop',
    trend: trendOf(metrics, 'recovery', { days, now }),
  } : null

  const sleep = fresh(sleepDay, now, freshDays) ? {
    dur: sleepDay.sleepDur ?? null,
    need: sleepDay.sleepNeed ?? null,
    perf: sleepDay.sleepPerf ?? null,
    // Only when both halves are known. A shortfall against an unknown need is not a number.
    short: sleepDay.sleepDur != null && sleepDay.sleepNeed != null
      ? Math.max(0, Math.round(sleepDay.sleepNeed - sleepDay.sleepDur))
      : null,
    d: sleepDay.d,
    stale: daysAgo(sleepDay.d, now),
  } : null

  const strain = fresh(strainDay, now, freshDays) && strainDay.strain != null ? {
    value: strainDay.strain,
    d: strainDay.d,
    stale: daysAgo(strainDay.d, now),
    trend: trendOf(metrics, 'strain', { days, now }),
  } : null

  return {
    has: true,
    any: !!(recovery || sleep || strain),
    stale: daysAgo(newest.d, now),
    recovery, sleep, strain,
  }
}
