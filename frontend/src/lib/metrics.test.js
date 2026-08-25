import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  fmtDuration, latestWith, daysAgo, seriesOf, averageOf, trendOf, sleepBreakdown,
  metricsSummary, LOWER_IS_BETTER, STAGE_FILL, STAGE_NAME,
} from './metrics.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = n => new Date(NOW - n * DAY).toISOString().slice(0, 10)

/** n days of series, newest last, `n - 1` days ago through today. */
const series = (n, f) => Array.from({ length: n }, (_, i) => ({ d: iso(n - 1 - i), ...f(i) }))

describe('fmtDuration', () => {
  it('reads as hours and minutes', () => {
    expect(fmtDuration(452)).toBe('7h 32m')
    expect(fmtDuration(60)).toBe('1h 00m')
    expect(fmtDuration(26)).toBe('26m')
    expect(fmtDuration(0)).toBe('0m')
  })
  it('refuses nonsense', () => {
    expect(fmtDuration(-5)).toBeNull()
    expect(fmtDuration(NaN)).toBeNull()
  })
})

describe('latestWith', () => {
  const m = [
    { d: '2026-08-20', recovery: 60 },
    { d: '2026-08-21', hrv: 44 },
    { d: '2026-08-22' },
  ]
  it('finds the newest day carrying the metric, not just the newest day', () => {
    expect(latestWith(m, ['recovery']).d).toBe('2026-08-20')
    expect(latestWith(m, ['hrv']).d).toBe('2026-08-21')
  })
  it('skips rows holding nothing but bookkeeping', () => {
    expect(latestWith(m).d).toBe('2026-08-21')
    expect(latestWith([{ d: '2026-08-22', t: 1, src: 'Whoop' }])).toBeNull()
  })
  it('returns null when nothing matches', () => {
    expect(latestWith(m, ['strain'])).toBeNull()
    expect(latestWith([], ['hrv'])).toBeNull()
    expect(latestWith(null)).toBeNull()
  })
})

describe('daysAgo', () => {
  it('counts back from today', () => {
    expect(daysAgo(iso(0), NOW)).toBe(0)
    expect(daysAgo(iso(3), NOW)).toBe(3)
    expect(daysAgo(iso(30), NOW)).toBe(30)
  })
  it('never reports the future as negative', () => {
    expect(daysAgo(new Date(NOW + 5 * DAY).toISOString().slice(0, 10), NOW)).toBe(0)
  })
})

describe('seriesOf', () => {
  const m = series(40, i => ({ recovery: 50 + (i % 10) }))

  it('returns chart points inside the window, oldest first', () => {
    const pts = seriesOf(m, 'recovery', { days: 30, now: NOW })
    expect(pts.length).toBeLessThanOrEqual(31)
    expect(pts[0].t).toBeLessThan(pts[pts.length - 1].t)
    expect(pts[0]).toHaveProperty('y')
    expect(pts[0]).toHaveProperty('d')
  })

  it('drops days missing the metric rather than plotting them as zero', () => {
    // A night on the charger is an absence. Drawing it as 0 invents a catastrophic night.
    const gappy = [
      { d: iso(3), recovery: 60 }, { d: iso(2) }, { d: iso(1), recovery: 70 },
    ]
    const pts = seriesOf(gappy, 'recovery', { days: 30, now: NOW })
    expect(pts).toHaveLength(2)
    expect(pts.map(p => p.y)).toEqual([60, 70])
  })

  it('returns empty rather than throwing on junk', () => {
    expect(seriesOf(null, 'recovery')).toEqual([])
    expect(seriesOf([], 'recovery')).toEqual([])
  })
})

describe('averageOf', () => {
  it('averages the window', () => {
    const m = [{ d: iso(2), hrv: 40 }, { d: iso(1), hrv: 50 }, { d: iso(0), hrv: 60 }]
    expect(averageOf(m, 'hrv', { days: 30, now: NOW })).toBe(50)
  })
  it('returns null when the window holds none of it', () => {
    expect(averageOf([{ d: iso(1), hrv: 40 }], 'strain', { now: NOW })).toBeNull()
  })
})

describe('trendOf', () => {
  const m = series(20, i => ({ recovery: 50, rhr: 55 }))

  it('compares today against the days before it', () => {
    const withSpike = [...m.slice(0, -1), { d: iso(0), recovery: 80, rhr: 55 }]
    const t = trendOf(withSpike, 'recovery', { now: NOW })
    expect(t.value).toBe(80)
    expect(t.base).toBe(50)
    expect(t.delta).toBe(30)
  })

  it('excludes today from its own baseline', () => {
    const withSpike = [...m.slice(0, -1), { d: iso(0), recovery: 80 }]
    expect(trendOf(withSpike, 'recovery', { now: NOW }).base).toBe(50)
  })

  it('knows which direction is good for each metric', () => {
    // A rising HRV and a falling resting heart rate are both good news; the sign alone
    // cannot say that, so callers would otherwise each have to re-derive it.
    const hrvUp = [...series(20, () => ({ hrv: 40 })).slice(0, -1), { d: iso(0), hrv: 55 }]
    expect(trendOf(hrvUp, 'hrv', { now: NOW }).better).toBe(1)

    const rhrUp = [...series(20, () => ({ rhr: 52 })).slice(0, -1), { d: iso(0), rhr: 62 }]
    expect(rhrUp.length).toBeGreaterThan(3)
    expect(trendOf(rhrUp, 'rhr', { now: NOW }).better).toBe(-1)

    const rhrDown = [...series(20, () => ({ rhr: 62 })).slice(0, -1), { d: iso(0), rhr: 52 }]
    expect(trendOf(rhrDown, 'rhr', { now: NOW }).better).toBe(1)
  })

  it('marks the metrics where lower is better', () => {
    expect(LOWER_IS_BETTER.has('rhr')).toBe(true)
    expect(LOWER_IS_BETTER.has('sleepDebt')).toBe(true)
    expect(LOWER_IS_BETTER.has('recovery')).toBe(false)
  })

  it('refuses a baseline of one or two days', () => {
    expect(trendOf([{ d: iso(1), recovery: 60 }, { d: iso(0), recovery: 70 }], 'recovery', { now: NOW })).toBeNull()
  })

  it('returns null for a metric that is not there', () => {
    expect(trendOf(m, 'strain', { now: NOW })).toBeNull()
  })
})

describe('sleepBreakdown', () => {
  const night = { sleepDur: 395, light: 136, deep: 115, rem: 144, awake: 67 }

  it('splits the night into stages that sum to the whole', () => {
    const b = sleepBreakdown(night)
    expect(b.total).toBe(395)
    expect(b.stages.reduce((a, s) => a + s.min, 0)).toBe(395)
    expect(b.stages.reduce((a, s) => a + s.pct, 0)).toBeGreaterThan(98)
  })

  it('refuses a breakdown whose parts do not add up', () => {
    // If a column was matched to the wrong metric this identity breaks, so the check doubles
    // as a correctness test on the import. Slices that do not sum are worse than no chart:
    // a reader has no way to tell they are looking at nonsense.
    expect(sleepBreakdown({ ...night, rem: 300 })).toBeNull()
  })

  it('allows a few minutes of rounding', () => {
    expect(sleepBreakdown({ ...night, light: 138 })).not.toBeNull()
  })

  it('returns null when a stage is missing entirely', () => {
    expect(sleepBreakdown({ sleepDur: 395, light: 136, deep: 115 })).toBeNull()
    expect(sleepBreakdown({ light: 1, deep: 1, rem: 1 })).toBeNull()
    expect(sleepBreakdown(null)).toBeNull()
  })
})

describe('metricsSummary', () => {
  const full = series(40, i => ({
    recovery: 55 + (i % 7), hrv: 45 + (i % 5), rhr: 54 - (i % 3),
    strain: 8 + (i % 6), sleepDur: 430 + (i % 30), sleepPerf: 85 + (i % 5),
    sleepNeed: 480, light: 200, deep: 100, rem: 130,
  }))

  it('summarises a full series', () => {
    const s = metricsSummary({ metrics: full }, { now: NOW })
    expect(s.ok).toBe(true)
    expect(s.recovery.pct).toBeGreaterThan(0)
    expect(s.recovery.zone).toMatch(/green|yellow|red/)
    expect(s.sleep.dur).toBeGreaterThan(0)
    expect(s.strain.value).toBeGreaterThan(0)
    expect(s.series.recovery.length).toBeGreaterThan(0)
  })

  it('reports how stale the data is instead of implying it is today', () => {
    // An import describes days up to when it was taken. A three-week-old recovery score looks
    // exactly like a fresh one, so the age has to travel with the number.
    const old = series(40, () => ({ recovery: 60 })).map((m, i) => ({
      ...m, d: new Date(NOW - (60 - i) * DAY).toISOString().slice(0, 10),
    }))
    const s = metricsSummary({ metrics: old }, { now: NOW })
    expect(s.stale).toBeGreaterThan(19)
    expect(s.recovery.stale).toBeGreaterThan(19)
  })

  it('says where a recovery score came from', () => {
    const s = metricsSummary({ metrics: full }, { now: NOW })
    expect(['whoop', 'computed']).toContain(s.recovery.src)
  })

  it('computes recovery for days Whoop did not score', () => {
    // HRV and resting HR are present throughout but no recovery column was imported, so the
    // rolling-baseline model should fill the later days in and label them computed.
    const noScore = series(40, i => ({ hrv: 45 + (i % 9), rhr: 54 - (i % 4) }))
    const s = metricsSummary({ metrics: noScore }, { now: NOW })
    expect(s.recovery).not.toBeNull()
    expect(s.recovery.src).toBe('computed')
  })

  it('refuses when there is nothing imported at all', () => {
    expect(metricsSummary({ metrics: [] }, { now: NOW })).toEqual({ ok: false, missing: ['metrics'] })
    expect(metricsSummary({}, { now: NOW }).ok).toBe(false)
    expect(metricsSummary(null, { now: NOW }).ok).toBe(false)
  })

  it('returns nulls, not zeros, for the sections a partial import cannot fill', () => {
    // Sleep-only data must not imply a recovery of 0 — an absent metric and a bad one look
    // identical once a zero reaches a chart.
    const sleepOnly = series(10, () => ({ sleepDur: 440, sleepPerf: 88 }))
    const s = metricsSummary({ metrics: sleepOnly }, { now: NOW })
    expect(s.ok).toBe(true)
    expect(s.sleep.dur).toBe(440)
    expect(s.recovery).toBeNull()
    expect(s.strain).toBeNull()
  })

  it('never throws on a malformed series', () => {
    for (const m of [[{}], [{ d: 'nope' }], [{ d: iso(1), recovery: null }]]) {
      expect(() => metricsSummary({ metrics: m }, { now: NOW })).not.toThrow()
    }
  })
})

describe('stage colours', () => {
  it('names only tokens the stylesheet actually defines', () => {
    // An undefined CSS variable paints transparent rather than erroring, so a typo makes a
    // chart segment silently vanish. This shipped once with --violet and --sky, which are
    // accent *key* names and not palette tokens, and two of three stages were invisible.
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    for (const [stage, value] of Object.entries(STAGE_FILL)) {
      const token = /var\((--[a-z0-9-]+)\)/.exec(value)[1]
      expect(css.includes(token + ':'), `${stage} uses ${token}, which index.css does not define`).toBe(true)
    }
  })
  it('gives every stage a label', () => {
    expect(Object.keys(STAGE_FILL).sort()).toEqual(Object.keys(STAGE_NAME).sort())
  })
})
