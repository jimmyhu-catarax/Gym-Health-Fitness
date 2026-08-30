import { describe, it, expect } from 'vitest'
import { morningBrief, FRESH_DAYS } from './brief.js'
import { ZONE_NOTE } from './readiness.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = n => new Date(NOW - n * DAY).toISOString().slice(0, 10)

/** n consecutive days ending `endsAgo` days ago. */
const series = (n, f, endsAgo = 0) =>
  Array.from({ length: n }, (_, i) => ({ d: iso(n - 1 - i + endsAgo), ...f(i) }))

const full = (over = {}) => ({ recovery: 72, sleepDur: 430, sleepNeed: 480, sleepPerf: 90, strain: 11.4, hrv: 55, rhr: 52, ...over })

describe('morningBrief', () => {
  it('says nothing at all before any import', () => {
    for (const S of [null, undefined, {}, { metrics: [] }, { metrics: null }]) {
      const b = morningBrief(S, { now: NOW })
      expect(b.has).toBe(false)
      expect(b.any).toBe(false)
      expect(b.recovery).toBeNull()
      expect(b.sleep).toBeNull()
      expect(b.strain).toBeNull()
    }
  })

  it('reports all three when the band is current', () => {
    const b = morningBrief({ metrics: series(30, () => full()) }, { now: NOW })
    expect(b.has).toBe(true)
    expect(b.any).toBe(true)
    expect(b.recovery.pct).toBe(72)
    expect(b.recovery.zone).toBe('green')
    expect(b.recovery.note).toBe(ZONE_NOTE.green)
    expect(b.sleep.dur).toBe(430)
    expect(b.strain.value).toBeCloseTo(11.4)
  })

  it('still shows yesterday — a completed strain day is normally yesterday', () => {
    const b = morningBrief({ metrics: series(30, () => full(), 1) }, { now: NOW })
    expect(b.strain).not.toBeNull()
    expect(b.strain.stale).toBe(1)
    expect(b.recovery.stale).toBe(1)
  })

  it('drops every number once the band has not been synced in days', () => {
    const b = morningBrief({ metrics: series(30, () => full(), 4) }, { now: NOW })
    expect(b.has).toBe(true)      // there IS data — the UI must say "sync", not "import"
    expect(b.any).toBe(false)
    expect(b.recovery).toBeNull()
    expect(b.sleep).toBeNull()
    expect(b.strain).toBeNull()
    expect(b.stale).toBe(4)
  })

  it('gates each metric on its own date, not on the newest row', () => {
    // Worn last night, not the night before: sleep is about this morning, strain is not.
    const metrics = [
      ...series(20, () => full()).slice(0, -2),
      { d: iso(1), strain: 9.1 },
      { d: iso(0), sleepDur: 400, sleepPerf: 84 },
    ]
    const b = morningBrief({ metrics }, { now: NOW })
    expect(b.sleep.stale).toBe(0)
    expect(b.strain.stale).toBe(1)

    // Push the last strain out of range and only it disappears.
    const older = metrics.map(m => (m.strain != null && m.d === iso(1) ? { d: iso(1) } : m))
    const b2 = morningBrief({ metrics: older.filter(m => m.d !== iso(3)) }, { now: NOW })
    expect(b2.sleep).not.toBeNull()
    expect(b2.strain).toBeNull()
    expect(b2.any).toBe(true)
  })

  it('reports a sleep shortfall only when it knows both halves', () => {
    const withNeed = morningBrief({ metrics: series(5, () => full({ sleepDur: 400, sleepNeed: 480 })) }, { now: NOW })
    expect(withNeed.sleep.short).toBe(80)

    const noNeed = morningBrief({ metrics: series(5, () => ({ sleepDur: 400, sleepPerf: 82 })) }, { now: NOW })
    expect(noNeed.sleep.short).toBeNull()

    // Slept longer than needed is not a negative shortfall.
    const over = morningBrief({ metrics: series(5, () => full({ sleepDur: 520, sleepNeed: 480 })) }, { now: NOW })
    expect(over.sleep.short).toBe(0)
  })

  it('flags a score this app worked out rather than one the band measured', () => {
    // No recovery column at all — physiology.js scores it from HRV and resting HR.
    const metrics = series(30, i => ({ hrv: 50 + (i % 5), rhr: 52 }))
    const b = morningBrief({ metrics }, { now: NOW })
    expect(b.recovery).not.toBeNull()
    expect(b.recovery.src).toBe('computed')

    const measured = morningBrief({ metrics: series(30, () => full()) }, { now: NOW })
    expect(measured.recovery.src).toBe('whoop')
  })

  it('compares against your own recent normal, not a population', () => {
    // A fortnight at 50 then a day at 80: the number is unremarkable, the change is not.
    const metrics = [...series(20, () => ({ recovery: 50 })), { d: iso(0), recovery: 80 }]
    const b = morningBrief({ metrics }, { now: NOW })
    expect(b.recovery.trend).not.toBeNull()
    expect(b.recovery.trend.delta).toBeGreaterThan(0)
  })

  it('honours a caller-supplied freshness window', () => {
    const metrics = series(10, () => full(), 3)
    expect(morningBrief({ metrics }, { now: NOW }).any).toBe(false)
    expect(morningBrief({ metrics }, { now: NOW, freshDays: 5 }).any).toBe(true)
    expect(FRESH_DAYS).toBe(1)
  })
})
