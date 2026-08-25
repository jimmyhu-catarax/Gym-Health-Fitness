// Reading the daily physiological series back — the selectors the recovery UI is built on.
//
// whoop-metrics.js writes `S.metrics`, physiology.js fills in the days Whoop did not score,
// and this turns that series into the handful of things a card actually shows: where you are
// today, how that compares with your own recent normal, and what is missing.
//
// The one idea worth stating up front is **staleness**. An imported export describes the days
// up to the moment it was taken and nothing after, so the newest row in the series is not
// necessarily last night. A card that prints the newest row under the heading "Today" is
// wrong every day between imports, and wrong silently, because a three-week-old recovery
// score looks exactly like a fresh one. Everything here carries the date it belongs to and
// how many days back that is, so the UI can say "3 days ago" instead of implying "now".

import { withComputedRecovery, recoveryZone } from './physiology.js'

const DAY = 86400000
const round1 = n => Math.round(n * 10) / 10
const isoOf = ms => new Date(ms).toISOString().slice(0, 10)
const dayMs = d => Date.parse(String(d) + 'T12:00:00Z')

/** Units for display. Durations are minutes in storage and hours to a reader. */
export const UNIT = {
  recovery: '%', hrv: 'ms', rhr: 'bpm', spo2: '%', skinTemp: '°C', strain: '', kcal: 'cal',
  maxHr: 'bpm', avgHr: 'bpm', sleepPerf: '%', sleepEff: '%', sleepCons: '%',
  sleepDur: 'min', inBed: 'min', sleepNeed: 'min', sleepDebt: 'min',
  rem: 'min', deep: 'min', light: 'min', awake: 'min', respRate: 'rpm',
}

/**
 * Sleep stages, and the palette token each one is drawn in.
 *
 * Here rather than in the view so `metrics.test.js` can check the tokens actually exist. An
 * undefined CSS variable resolves to nothing and paints transparent — the segment does not
 * error, it just silently disappears, which is how the first version of this shipped with two
 * of its three stages invisible. The base palette is `--purple`/`--blue`/`--teal`; `violet`
 * and `sky` are per-profile *accent key* names, which is an easy and silent mistake to make.
 */
export const STAGE_FILL = { deep: 'var(--purple)', rem: 'var(--blue)', light: 'var(--teal)' }

/** Recovery zones. `-ink` for anything a person reads, the plain fill for anything they
 *  only look at — see frontend/src/CLAUDE.md; getting that backwards passes in dark mode
 *  and fails contrast in light. */
export const ZONE_FILL = { green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)' }
export const ZONE_INK = { green: 'var(--green-ink)', yellow: 'var(--yellow-ink)', red: 'var(--red-ink)' }
export const ZONE_NAME = { green: 'Recovered', yellow: 'Moderate', red: 'Run down' }
export const STAGE_NAME = { deep: 'Deep', rem: 'REM', light: 'Light' }

/** Metrics where a bigger number is worse, so a rising trend is not good news. */
export const LOWER_IS_BETTER = new Set(['rhr', 'sleepDebt', 'awake', 'respRate'])

/** Whole hours and minutes, because 452 minutes is not a quantity anybody feels. */
export function fmtDuration(min) {
  if (!isFinite(min) || min < 0) return null
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** The most recent day carrying any of `keys` (any key at all when none are named). */
export function latestWith(metrics, keys = null) {
  if (!Array.isArray(metrics)) return null
  for (let i = metrics.length - 1; i >= 0; i--) {
    const m = metrics[i]
    if (!keys) { if (Object.keys(m).some(k => !['d', 't', 'src'].includes(k))) return m }
    else if (keys.some(k => m[k] != null)) return m
  }
  return null
}

/** How many days ago a row is, relative to `now`. Negative would mean the future. */
export const daysAgo = (d, now = Date.now()) =>
  Math.max(0, Math.round((Date.parse(isoOf(now) + 'T12:00:00Z') - dayMs(d)) / DAY))

/**
 * A metric as chart points, newest last.
 *
 * Days missing that metric are dropped rather than plotted as zero: a night the band was on
 * the charger is an absence, and drawing it as a floor-scraping value invents a bad night.
 */
export function seriesOf(metrics, key, { days = 30, now = Date.now() } = {}) {
  if (!Array.isArray(metrics)) return []
  const since = now - days * DAY
  return metrics
    .filter(m => m[key] != null && dayMs(m.d) >= since)
    .map(m => ({ t: dayMs(m.d), y: m[key], d: m.d }))
}

/** Mean of a metric over a window, or null when the window holds none of it. */
export function averageOf(metrics, key, { days = 30, now = Date.now() } = {}) {
  const pts = seriesOf(metrics, key, { days, now })
  if (!pts.length) return null
  return round1(pts.reduce((a, p) => a + p.y, 0) / pts.length)
}

/**
 * Today's value against the preceding window — "is this normal for me".
 *
 * `better` is the direction that matters rather than the sign, so a card can colour a falling
 * resting heart rate the same green as a rising HRV without every caller re-deriving which
 * way each metric points.
 */
export function trendOf(metrics, key, { days = 30, now = Date.now() } = {}) {
  const latest = latestWith(metrics, [key])
  if (!latest) return null
  const prior = metrics.filter(m => m[key] != null && m.d < latest.d)
  if (prior.length < 3) return null
  const win = prior.slice(-days)
  const base = round1(win.reduce((a, m) => a + m[key], 0) / win.length)
  const delta = round1(latest[key] - base)
  const better = delta === 0 ? 0 : (delta > 0) === LOWER_IS_BETTER.has(key) ? -1 : 1
  return { value: latest[key], d: latest.d, base, delta, better, n: win.length }
}

/**
 * The night's stages as minutes and as a share of time asleep.
 *
 * Returns null unless the parts actually add up. Whoop's own arithmetic is
 * light + deep + REM = asleep, and if a column was matched to the wrong metric that identity
 * breaks — so it doubles as a correctness check on the import. Rendering a breakdown whose
 * slices do not sum is worse than rendering none, because a reader has no way to tell.
 */
export function sleepBreakdown(day, { tolerance = 5 } = {}) {
  if (!day) return null
  const { light, deep, rem, awake, sleepDur } = day
  if ([light, deep, rem].some(v => v == null) || !sleepDur) return null
  const sum = light + deep + rem
  if (Math.abs(sum - sleepDur) > tolerance) return null
  const pct = v => Math.round((v / sleepDur) * 100)
  return {
    total: sleepDur, awake: awake ?? null,
    stages: [
      { k: 'deep', min: deep, pct: pct(deep) },
      { k: 'rem', min: rem, pct: pct(rem) },
      { k: 'light', min: light, pct: pct(light) },
    ],
  }
}

/**
 * Everything the recovery card needs, or a refusal naming what is absent.
 *
 * Computed recovery is folded in here rather than at import, so a profile that later gains
 * more history re-derives the days it could not score before instead of being stuck with
 * whatever was true on import day.
 */
export function metricsSummary(S, { now = Date.now(), days = 30 } = {}) {
  const raw = (S && S.metrics) || []
  if (!raw.length) return { ok: false, missing: ['metrics'] }

  const metrics = withComputedRecovery(raw)
  const latest = latestWith(metrics)
  if (!latest) return { ok: false, missing: ['metrics'] }

  const rec = latestWith(metrics, ['recovery'])
  const sleep = latestWith(metrics, ['sleepDur', 'sleepPerf'])
  const strain = latestWith(metrics, ['strain'])

  return {
    ok: true,
    metrics,
    latest,
    stale: daysAgo(latest.d, now),
    recovery: rec ? {
      pct: rec.recovery, zone: recoveryZone(rec.recovery), d: rec.d,
      src: rec.recoverySrc || 'whoop', stale: daysAgo(rec.d, now),
      trend: trendOf(metrics, 'recovery', { days, now }),
    } : null,
    sleep: sleep ? {
      d: sleep.d, stale: daysAgo(sleep.d, now),
      dur: sleep.sleepDur ?? null, need: sleep.sleepNeed ?? null,
      perf: sleep.sleepPerf ?? null, eff: sleep.sleepEff ?? null,
      breakdown: sleepBreakdown(sleep),
    } : null,
    strain: strain ? {
      value: strain.strain, d: strain.d, stale: daysAgo(strain.d, now),
      trend: trendOf(metrics, 'strain', { days, now }),
    } : null,
    hrv: trendOf(metrics, 'hrv', { days, now }),
    rhr: trendOf(metrics, 'rhr', { days, now }),
    series: {
      recovery: seriesOf(metrics, 'recovery', { days, now }),
      strain: seriesOf(metrics, 'strain', { days, now }),
      sleepDur: seriesOf(metrics, 'sleepDur', { days, now }),
    },
  }
}
