import { describe, it, expect } from 'vitest'
import {
  stageMix, sleepShortfall, loadBalance, weeklyStrain, trendDetail,
  loadBand, LOAD_BANDS, STAGES, MIX_MIN_NIGHTS, ACUTE_DAYS, CHRONIC_DAYS,
} from './trends.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = n => new Date(NOW - n * DAY).toISOString().slice(0, 10)

/** n days ending today, newest last. */
const days = (n, f) => Array.from({ length: n }, (_, i) => ({ d: iso(n - 1 - i), ...f(i, n) }))
/** A night whose stages sum to its total, which is what stageMix requires. */
const night = (deep, rem, light) => ({ deep, rem, light, sleepDur: deep + rem + light })

describe('stageMix', () => {
  it('averages the mix and reports it in both minutes and share', () => {
    const m = days(20, () => night(96, 112, 220))
    const r = stageMix(m, { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.nights).toBe(20)
    expect(r.avg.deep.min).toBe(96)
    expect(r.avg.deep.pct).toBe(Math.round((96 / 428) * 100))
    expect(STAGES.reduce((a, k) => a + r.avg[k].pct, 0)).toBeGreaterThan(98)
  })

  it('catches deep sleep draining out of a night whose total never moves', () => {
    // The exact failure a single "Sleep" line cannot show: duration flat, composition worse.
    const m = days(20, i => (i < 10 ? night(110, 110, 208) : night(70, 110, 248)))
    const r = stageMix(m, { now: NOW })
    expect(r.avg.total).toBe(428)              // total unchanged across the window
    expect(r.shift.deep.min).toBe(-40)         // and yet 40 minutes of deep sleep are gone
    expect(r.shift.deep.pct).toBeLessThan(0)
  })

  it('separates a share that holds from minutes that fall', () => {
    // Same proportions, shorter nights. Share is flat; minutes are down. Both are reported
    // because they are different facts and either alone misleads.
    const m = days(20, i => (i < 10 ? night(100, 100, 200) : night(75, 75, 150)))
    const r = stageMix(m, { now: NOW })
    expect(r.shift.deep.pct).toBe(0)
    expect(r.shift.deep.min).toBe(-25)
  })

  it('refuses a window too thin to claim a shift', () => {
    const r = stageMix(days(4, () => night(96, 112, 220)), { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.need).toBe(MIX_MIN_NIGHTS)
  })

  it('ignores nights whose stages do not sum to the total', () => {
    // A mismatched sum means a column was read as the wrong metric; averaging it in would
    // launder a parse error into a chart.
    const good = days(12, () => night(96, 112, 220))
    const broken = [...good, { d: iso(0), deep: 96, rem: 112, light: 220, sleepDur: 900 }]
    expect(stageMix(broken, { now: NOW }).nights).toBe(12)
  })

  it('ignores nights missing a stage entirely', () => {
    const m = [...days(10, () => night(96, 112, 220)),
      { d: iso(0), deep: 96, rem: 112, sleepDur: 428 }]
    expect(stageMix(m, { now: NOW }).nights).toBe(10)
  })

  it('survives junk', () => {
    expect(stageMix(null)).toBeNull()
    expect(stageMix([], { now: NOW }).ok).toBe(false)
  })
})

describe('sleepShortfall', () => {
  it('reports the average shortfall and how many nights met the need', () => {
    const m = days(10, i => ({ sleepDur: i < 5 ? 400 : 500, sleepNeed: 480 }))
    const r = sleepShortfall(m, { now: NOW })
    expect(r.nights).toBe(10)
    expect(r.avg).toBe(30)      // five short by 80, five over by 20 -> (400-100)/10
    expect(r.worst).toBe(80)
    expect(r.met).toBe(5)
  })
  it('gives points in hours, since minutes do not read on an axis', () => {
    const r = sleepShortfall(days(4, () => ({ sleepDur: 420, sleepNeed: 480 })), { now: NOW })
    expect(r.points[0].y).toBe(1)
  })
  it('needs both a duration and a need', () => {
    expect(sleepShortfall(days(5, () => ({ sleepDur: 420 })), { now: NOW })).toBeNull()
    expect(sleepShortfall([], { now: NOW })).toBeNull()
  })
})

describe('loadBalance', () => {
  it('calls a week matching the month steady', () => {
    const r = loadBalance(days(30, () => ({ strain: 12 })), { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.ratio).toBeCloseTo(1, 1)
    expect(r.band.key).toBe('steady')
  })

  it('calls a hard week on top of an easy month ramping', () => {
    const r = loadBalance(days(30, (i, n) => ({ strain: i >= n - 7 ? 18 : 8 })), { now: NOW })
    expect(r.acute).toBeGreaterThan(r.chronic)
    expect(r.ratio).toBeGreaterThan(1.3)
    expect(r.band.key).toBe('ramping')
  })

  it('calls a deload week easing off', () => {
    const r = loadBalance(days(30, (i, n) => ({ strain: i >= n - 7 ? 4 : 14 })), { now: NOW })
    expect(r.ratio).toBeLessThan(0.8)
    expect(r.band.key).toBe('easing')
  })

  it('refuses without a real chronic baseline', () => {
    // A 28-day window built from nine days is not a baseline; the ratio would be whatever
    // those nine days happened to be.
    const r = loadBalance(days(9, () => ({ strain: 12 })), { now: NOW })
    expect(r.ok).toBe(false)
    expect(r.need).toBeGreaterThan(9)
  })

  it('judges coverage, not row count', () => {
    // Thirty rows spanning thirty days, but only six carry strain.
    const sparse = days(30, i => (i % 5 === 0 ? { strain: 12 } : {}))
    expect(loadBalance(sparse, { now: NOW }).ok).toBe(false)
  })

  it('uses the published window lengths', () => {
    expect(ACUTE_DAYS).toBe(7)
    expect(CHRONIC_DAYS).toBe(28)
  })

  it('names bands for what they describe, never for risk', () => {
    // The ratio is methodologically contested (Impellizzeri 2020: the windows are
    // mathematically coupled). Describing load is defensible; predicting injury is not.
    const labels = LOAD_BANDS.map(b => b.label.toLowerCase()).join(' ')
    for (const word of ['risk', 'danger', 'injury', 'unsafe', 'warning']) {
      expect(labels).not.toContain(word)
    }
  })

  it('bands the whole range without a gap', () => {
    for (const r of [0, 0.5, 0.79, 0.8, 1.0, 1.29, 1.3, 2, 10]) {
      expect(loadBand(r), `ratio ${r}`).toBeDefined()
    }
  })

  it('survives junk', () => {
    expect(loadBalance(null)).toBeNull()
    expect(loadBalance([], { now: NOW }).ok).toBe(false)
  })
})

describe('weeklyStrain', () => {
  it('sums by week rather than averaging', () => {
    // Five hard days plus two rest days is a different week from seven moderate ones, even
    // where the mean matches — the sum is what a training block is.
    const w = weeklyStrain(days(28, () => ({ strain: 10 })), { weeks: 4, now: NOW })
    expect(w.length).toBeGreaterThanOrEqual(4)
    expect(w.every(x => x.total === x.days * 10)).toBe(true)
  })

  it('labels a partial week with its day count', () => {
    // Otherwise the newest bar reads as a collapse in training rather than a week in progress.
    const w = weeklyStrain(days(10, () => ({ strain: 10 })), { weeks: 4, now: NOW })
    expect(w[w.length - 1].days).toBeLessThanOrEqual(7)
    expect(w.every(x => x.days > 0)).toBe(true)
  })

  it('comes back oldest first', () => {
    const w = weeklyStrain(days(28, () => ({ strain: 10 })), { weeks: 4, now: NOW })
    expect(w.map(x => x.from)).toEqual([...w.map(x => x.from)].sort())
  })

  it('skips days with no strain', () => {
    expect(weeklyStrain(days(14, () => ({ sleepDur: 400 })), { now: NOW })).toEqual([])
  })
})

describe('trendDetail', () => {
  it('assembles every section when the data supports it', () => {
    const m = days(30, () => ({ ...night(96, 112, 220), sleepNeed: 480, strain: 12 }))
    const r = trendDetail({ metrics: m }, { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.mix.ok).toBe(true)
    expect(r.load.ok).toBe(true)
    expect(r.shortfall.nights).toBe(30)
    expect(r.weekly.length).toBeGreaterThan(0)
  })

  it('gives the half it can when the export only has sleep', () => {
    // A partial answer naming what is missing beats a blank card.
    const m = days(20, () => ({ ...night(96, 112, 220), sleepNeed: 480 }))
    const r = trendDetail({ metrics: m }, { now: NOW })
    expect(r.mix.ok).toBe(true)
    expect(r.load.ok).toBe(false)
    expect(r.weekly).toEqual([])
  })

  it('gives the half it can when the export only has strain', () => {
    const r = trendDetail({ metrics: days(30, () => ({ strain: 12 })) }, { now: NOW })
    expect(r.load.ok).toBe(true)
    expect(r.mix.ok).toBe(false)
    expect(r.shortfall).toBeNull()
  })

  it('refuses when nothing is imported', () => {
    expect(trendDetail({ metrics: [] }, { now: NOW })).toEqual({ ok: false, missing: ['metrics'] })
    expect(trendDetail(null, { now: NOW }).ok).toBe(false)
  })

  it('never throws on a malformed series', () => {
    for (const m of [[{}], [{ d: 'nope' }], [{ d: iso(1), strain: null }]]) {
      expect(() => trendDetail({ metrics: m }, { now: NOW })).not.toThrow()
    }
  })
})
