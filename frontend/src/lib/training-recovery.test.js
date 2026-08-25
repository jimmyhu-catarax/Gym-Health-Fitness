import { describe, it, expect } from 'vitest'
import {
  pearson, mean, fmtR, pairDays, recoveryAfterTraining, volumeByZone, relate,
  trainingRecoveryReport, MIN_PAIRS, R_NOTABLE,
} from './training-recovery.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = n => new Date(NOW - n * DAY).toISOString().slice(0, 10)

/** A workout on day `d` with one set carrying the whole volume, so totals are predictable. */
const workout = (d, weight, reps = 10) => ({
  d, entries: [{ id: 'x', sets: [{ w: weight, r: reps, done: true }] }],
})

/** n days of metrics, newest last. */
const metrics = (n, f) => Array.from({ length: n }, (_, i) => ({ d: iso(n - 1 - i), ...f(i) }))

describe('pearson', () => {
  it('is 1 for a perfect rise and -1 for a perfect fall', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBe(1)
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBe(-1)
  })
  it('matches a hand-computed case', () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(0.77, 2)
  })
  it('is near zero for unrelated columns', () => {
    expect(Math.abs(pearson([1, 2, 3, 4], [3, 1, 4, 2]))).toBeLessThan(0.5)
  })
  it('returns null rather than 0 when a column never varies', () => {
    // 0 would read as "measured, and found no relationship". There is nothing to measure.
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull()
  })
  it('never returns negative zero', () => {
    // A correlation rounding to nothing is nothing; "r=-0" on a card reads as a broken
    // number rather than as an absence of relationship.
    const r = pearson([1, 2, 3, 4, 5, 6], [3, 1, 4, 1, 5, 2])
    expect(Object.is(r, -0)).toBe(false)
  })

  it('refuses too few points', () => {
    expect(pearson([1, 2], [2, 4])).toBeNull()
    expect(pearson([], [])).toBeNull()
  })
})

describe('fmtR', () => {
  it('keeps two decimals, which is the convention for r', () => {
    expect(fmtR(-0.9, 'en-US')).toBe('-0.90')
    expect(fmtR(0.77, 'en-US')).toBe('0.77')
    expect(fmtR(1, 'en-US')).toBe('1.00')
  })
  it('does not flatten a small correlation into a broken-looking "-0"', () => {
    // The app's general formatter rounds to one decimal, so -0.03 came out as the string
    // "-0" — which reads as a broken number rather than as "no relationship". A real
    // coefficient this small is still a real coefficient.
    expect(fmtR(-0.03, 'en-US')).toBe('-0.03')
    expect(fmtR(0.04, 'en-US')).toBe('0.04')
  })
  it('never renders negative zero', () => {
    expect(fmtR(-0, 'en-US')).toBe('0.00')
    expect(fmtR(0, 'en-US')).toBe('0.00')
  })
  it('returns null on nonsense', () => {
    expect(fmtR(NaN)).toBeNull()
    expect(fmtR(undefined)).toBeNull()
  })
})

describe('mean', () => {
  it('averages, and returns null on empty', () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(mean([])).toBeNull()
  })
})

describe('pairDays', () => {
  const S = {
    metrics: metrics(30, i => ({ recovery: 50 + i, strain: 10, sleepDur: 420 })),
    workouts: [workout(iso(5), 100), workout(iso(3), 50)],
  }

  it('joins both halves on the calendar day', () => {
    const pairs = pairDays(S, { now: NOW })
    const day = pairs.find(p => p.d === iso(5))
    expect(day.trained).toBe(true)
    expect(day.volume).toBe(1000)
    expect(day.recovery).not.toBeNull()
  })

  it('marks untrained days rather than dropping them', () => {
    // Rest days are half the comparison; dropping them would leave nothing to compare against.
    const pairs = pairDays(S, { now: NOW })
    expect(pairs.filter(p => !p.trained).length).toBeGreaterThan(20)
  })

  it('sums two sessions logged on the same day', () => {
    const two = { ...S, workouts: [workout(iso(5), 100), workout(iso(5), 40)] }
    expect(pairDays(two, { now: NOW }).find(p => p.d === iso(5)).volume).toBe(1400)
  })

  it('carries the following day’s recovery, not the same day’s', () => {
    // Recovery is scored on waking, so today's number was fixed before today's training.
    // Only tomorrow's can have been moved by it.
    const pairs = pairDays(S, { now: NOW })
    const d5 = pairs.find(p => p.d === iso(5))
    const d4 = pairs.find(p => p.d === iso(4))
    expect(d5.nextRecovery).toBe(d4.recovery)
  })

  it('leaves nextRecovery null at the end of the series', () => {
    expect(pairDays(S, { now: NOW }).find(p => p.d === iso(0)).nextRecovery).toBeNull()
  })

  it('honours the window', () => {
    expect(pairDays(S, { now: NOW, days: 7 }).length).toBeLessThanOrEqual(8)
  })

  it('returns empty rather than throwing without metrics', () => {
    expect(pairDays({ workouts: [workout(iso(1), 100)] }, { now: NOW })).toEqual([])
    expect(pairDays({}, { now: NOW })).toEqual([])
    expect(pairDays(null, { now: NOW })).toEqual([])
  })
})

describe('recoveryAfterTraining', () => {
  it('finds a real cost when one is there', () => {
    // Trained days are followed by 40, rest days by 70.
    const pairs = Array.from({ length: 24 }, (_, i) => ({
      d: iso(24 - i), trained: i % 2 === 0, volume: i % 2 === 0 ? 1000 : 0,
      nextRecovery: i % 2 === 0 ? 40 : 70, recovery: 60,
    }))
    const r = recoveryAfterTraining(pairs)
    expect(r.after).toBe(40)
    expect(r.rest).toBe(70)
    expect(r.delta).toBe(-30)
    expect(r.nAfter).toBe(12)
  })

  it('reports no gap when there is none', () => {
    const pairs = Array.from({ length: 24 }, (_, i) => ({
      trained: i % 2 === 0, nextRecovery: 60,
    }))
    expect(recoveryAfterTraining(pairs).delta).toBe(0)
  })

  it('refuses when either group is too thin to compare', () => {
    // Someone who trains every day has no rest days to compare against, and the honest
    // answer is that this question cannot be asked of their data.
    const allTrained = Array.from({ length: 24 }, () => ({ trained: true, nextRecovery: 55 }))
    expect(recoveryAfterTraining(allTrained)).toBeNull()
  })

  it('ignores days with no following score', () => {
    const pairs = Array.from({ length: 24 }, (_, i) => ({ trained: i % 2 === 0, nextRecovery: null }))
    expect(recoveryAfterTraining(pairs)).toBeNull()
  })
})

describe('volumeByZone', () => {
  const mk = (zoneRecovery, volume, n) =>
    Array.from({ length: n }, () => ({ trained: true, volume, recovery: zoneRecovery }))

  it('groups training volume by the morning’s zone', () => {
    const pairs = [...mk(80, 2000, 5), ...mk(50, 1500, 5), ...mk(20, 800, 5)]
    const out = volumeByZone(pairs)
    expect(out.green).toEqual({ mean: 2000, n: 5 })
    expect(out.yellow).toEqual({ mean: 1500, n: 5 })
    expect(out.red).toEqual({ mean: 800, n: 5 })
  })

  it('counts only days that were actually trained', () => {
    // Rest days have zero volume. Including them would compare "how much do you lift when
    // recovered" against a pile of zeroes and invent a huge effect out of the fact that
    // people take rest days.
    const pairs = [...mk(80, 2000, 5), ...mk(20, 900, 5),
      ...Array.from({ length: 20 }, () => ({ trained: false, volume: 0, recovery: 20 }))]
    expect(volumeByZone(pairs).red.n).toBe(5)
    expect(volumeByZone(pairs).red.mean).toBe(900)
  })

  it('leaves a zone null rather than reporting an empty mean', () => {
    const out = volumeByZone([...mk(80, 2000, 5), ...mk(50, 1500, 5)])
    expect(out.red).toBeNull()
  })

  it('refuses when there are barely any trained days at all', () => {
    expect(volumeByZone(mk(80, 2000, 3))).toBeNull()
  })
})

describe('relate', () => {
  const rows = n => Array.from({ length: n }, (_, i) => ({
    trained: true, volume: 100 + i * 10, strain: i, nextRecovery: 90 - i * 2, sleepDur: 400 + i,
  }))

  it('reports a correlation once there are enough pairs', () => {
    const r = relate(rows(20), 'strain', 'nextRecovery')
    expect(r.ok).toBe(true)
    expect(r.r).toBeCloseTo(-1, 1)
    expect(r.n).toBe(20)
    expect(r.notable).toBe(true)
    expect(r.direction).toBe('down')
  })

  it('refuses below the minimum and says what it needs', () => {
    // With eight pairs you can pull |r| > 0.5 out of dice. Reporting it would be worse than
    // reporting nothing, because a number carries authority that a blank does not.
    const r = relate(rows(8), 'strain', 'nextRecovery')
    expect(r.ok).toBe(false)
    expect(r.n).toBe(8)
    expect(r.need).toBe(MIN_PAIRS)
  })

  it('marks a weak relationship as not notable rather than hiding it', () => {
    const noisy = Array.from({ length: 30 }, (_, i) => ({
      trained: true, volume: 1000, strain: i, nextRecovery: 60 + ((i * 7) % 5),
    }))
    const r = relate(noisy, 'strain', 'nextRecovery')
    expect(r.ok).toBe(true)
    expect(Math.abs(r.r)).toBeLessThan(R_NOTABLE)
    expect(r.notable).toBe(false)
  })

  it('can restrict to days that were trained', () => {
    const mixed = [...rows(20), ...Array.from({ length: 20 }, () => ({
      trained: false, volume: 0, strain: 0, nextRecovery: 60, sleepDur: 400,
    }))]
    expect(relate(mixed, 'sleepDur', 'volume', { trainedOnly: true }).n).toBe(20)
    expect(relate(mixed, 'sleepDur', 'volume').n).toBe(40)
  })

  it('refuses a column that never varies', () => {
    const flat = Array.from({ length: 20 }, () => ({ trained: true, volume: 1000, strain: 5, nextRecovery: 60 }))
    expect(relate(flat, 'strain', 'nextRecovery').ok).toBe(false)
  })
})

describe('trainingRecoveryReport', () => {
  const S = {
    metrics: metrics(40, i => ({
      recovery: 45 + (i % 40), strain: 8 + (i % 10), sleepDur: 400 + (i % 60), hrv: 45,
    })),
    workouts: Array.from({ length: 18 }, (_, i) => workout(iso(i * 2), 80 + i)),
  }

  it('reports the whole cross-analysis', () => {
    const r = trainingRecoveryReport(S, { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.trainedDays).toBeGreaterThan(0)
    expect(r.strainVsNext).toHaveProperty('n')
    expect(r.caveat).toMatch(/not proof/i)
  })

  it('always carries the caveat — callers must render it', () => {
    // Every number in the report describes past days. None of it is evidence of cause, and
    // the difference is the entire risk of putting these two datasets side by side.
    expect(trainingRecoveryReport(S, { now: NOW }).caveat).toBeTruthy()
  })

  it('refuses with too little history and says how much it needs', () => {
    const thin = { metrics: metrics(6, () => ({ recovery: 60 })), workouts: [] }
    const r = trainingRecoveryReport(thin, { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.missing).toBe('pairs')
    expect(r.have).toBe(6)
    expect(r.need).toBe(MIN_PAIRS)
  })

  it('refuses when there is physiological data but no recovery in it', () => {
    const noRec = { metrics: metrics(40, () => ({ sleepDur: 430 })), workouts: [] }
    expect(trainingRecoveryReport(noRec, { now: NOW }).ok).toBe(false)
  })

  it('never throws on a malformed or empty profile', () => {
    // Persisted state survives version upgrades and backup round-trips, so it does not get
    // to be trusted. An unparseable date used to crash the whole Stats screen, because
    // new Date(NaN).toISOString() throws rather than returning something harmless.
    for (const s of [null, {}, { metrics: [], workouts: [] }, { metrics: [{ d: 'x' }] },
      { metrics: [{ d: null, recovery: 60 }] }, { metrics: [{ d: '2026-13-45' }] }]) {
      expect(() => trainingRecoveryReport(s, { now: NOW })).not.toThrow()
      expect(trainingRecoveryReport(s, { now: NOW }).ok).toBe(false)
    }
  })

  it('skips a bad date without discarding the good days around it', () => {
    const good = metrics(30, i => ({ recovery: 50 + (i % 30) }))
    const withJunk = { metrics: [{ d: 'not-a-date', recovery: 99 }, ...good], workouts: [] }
    const r = trainingRecoveryReport(withJunk, { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.days).toBe(30)
  })
})
