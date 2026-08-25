import { describe, it, expect } from 'vitest'
import { readinessFor, FRESH_DAYS, ZONE_NOTE } from './readiness.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = n => new Date(NOW - n * DAY).toISOString().slice(0, 10)

/** n days ending `endsAgo` days ago. */
const series = (n, f, endsAgo = 0) =>
  Array.from({ length: n }, (_, i) => ({ d: iso(n - 1 - i + endsAgo), ...f(i) }))

describe('readinessFor', () => {
  it('reports this morning’s score', () => {
    const r = readinessFor({ metrics: series(30, () => ({ recovery: 78, hrv: 50, rhr: 52 })) }, { now: NOW })
    expect(r.pct).toBe(78)
    expect(r.zone).toBe('green')
    expect(r.stale).toBe(0)
    expect(r.note).toBe(ZONE_NOTE.green)
  })

  it('names the zone the way the reader expects', () => {
    const at = v => readinessFor({ metrics: series(30, () => ({ recovery: v })) }, { now: NOW }).zone
    expect(at(80)).toBe('green')
    expect(at(50)).toBe('yellow')
    expect(at(20)).toBe('red')
  })

  it('still reports yesterday’s score', () => {
    // You may not have imported since this morning, and last night's recovery is still the
    // most recent thing anybody knows about you.
    const r = readinessFor({ metrics: series(30, () => ({ recovery: 70 }), 1) }, { now: NOW })
    expect(r).not.toBeNull()
    expect(r.stale).toBe(1)
  })

  it('says nothing at all once the score is history', () => {
    // Four days on, this is a fact about last Tuesday. Next to "Start workout" it reads as a
    // statement about today, so the honest output is nothing rather than something stale but
    // reassuringly present.
    expect(readinessFor({ metrics: series(30, () => ({ recovery: 70 }), 4) }, { now: NOW })).toBeNull()
    expect(readinessFor({ metrics: series(30, () => ({ recovery: 70 }), 30) }, { now: NOW })).toBeNull()
  })

  it('honours a caller that wants a wider window', () => {
    const m = series(30, () => ({ recovery: 70 }), 3)
    expect(readinessFor({ metrics: m }, { now: NOW })).toBeNull()
    expect(readinessFor({ metrics: m }, { now: NOW, freshDays: 5 })).not.toBeNull()
  })

  it('compares against your own baseline, not a population', () => {
    // 62% is a good day for one person and a bad one for another; only the personal
    // comparison carries information.
    const m = [...series(29, () => ({ recovery: 55 }), 1), { d: iso(0), recovery: 80 }]
    const r = readinessFor({ metrics: m }, { now: NOW })
    expect(r.trend.base).toBe(55)
    expect(r.trend.delta).toBe(25)
  })

  it('falls back to a computed score and says so', () => {
    const m = series(30, i => ({ hrv: 44 + (i % 7), rhr: 54 - (i % 3) }))
    const r = readinessFor({ metrics: m }, { now: NOW })
    expect(r).not.toBeNull()
    expect(r.src).toBe('computed')
  })

  it('prefers the score Whoop supplied', () => {
    const m = series(30, i => ({ recovery: 71, hrv: 44 + (i % 7), rhr: 54 }))
    expect(readinessFor({ metrics: m }, { now: NOW }).src).toBe('whoop')
  })

  it('returns null rather than a shell the UI has to interpret', () => {
    expect(readinessFor({ metrics: [] }, { now: NOW })).toBeNull()
    expect(readinessFor({}, { now: NOW })).toBeNull()
    expect(readinessFor(null, { now: NOW })).toBeNull()
    // Sleep but no recovery, and not enough of anything to compute one.
    expect(readinessFor({ metrics: series(3, () => ({ sleepDur: 440 })) }, { now: NOW })).toBeNull()
  })

  it('never throws on a malformed series', () => {
    for (const m of [[{}], [{ d: 'nope', recovery: 60 }], [{ d: iso(0), recovery: null }]]) {
      expect(() => readinessFor({ metrics: m }, { now: NOW })).not.toThrow()
    }
  })

  it('carries no prescription — only the reading and what it means', () => {
    // The app's progression engine owns load decisions, from logged performance. A second
    // system adjusting the same number would leave the user unable to tell which one moved
    // their weights, and "train lighter today" is advice this app is not placed to give.
    const r = readinessFor({ metrics: series(30, () => ({ recovery: 18 })) }, { now: NOW })
    expect(r.zone).toBe('red')
    expect(Object.keys(r).sort()).toEqual(['d', 'note', 'pct', 'src', 'stale', 'trend', 'zone'])
    for (const v of Object.values(ZONE_NOTE)) {
      expect(v).not.toMatch(/should|must|deload|lighter|skip|rest day|avoid/i)
    }
  })

  it('keeps the freshness window at a day unless told otherwise', () => {
    expect(FRESH_DAYS).toBe(1)
  })
})
