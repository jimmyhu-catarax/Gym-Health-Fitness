import { describe, it, expect } from 'vitest'
import {
  stageMix, sleepShortfall, loadBalance, weeklyStrain, trendDetail, liftingLoad,
  loadBand, LOAD_BANDS, STAGES, MIX_MIN_NIGHTS, ACUTE_DAYS, CHRONIC_DAYS,
} from './trends.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = n => new Date(NOW - n * DAY).toISOString().slice(0, 10)
const dayMsOf = d => Date.parse(d + 'T12:00:00Z')

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

  it('counts exactly as many days as the window names', () => {
    // Not n + 1. Once `fill` divides by the window length, an extra day's load in the
    // numerator reads as a heavier week than the week was.
    const r = loadBalance(days(30, () => ({ strain: 10 })), { now: NOW })
    expect(r.acuteDays).toBe(ACUTE_DAYS)
    expect(r.days).toBe(CHRONIC_DAYS)
  })

  it('survives junk', () => {
    expect(loadBalance(null)).toBeNull()
    expect(loadBalance([], { now: NOW }).ok).toBe(false)
  })
})

describe('loadBalance with rest days filled', () => {
  // A band records every day, so a gap is missing data. Lifting is intermittent by design,
  // so a gap is a rest day — a real zero, and part of the load picture rather than absent
  // from it.
  const sessions = (n, everyNth, load) =>
    Array.from({ length: n }, (_, i) => (i % everyNth === 0 ? { d: iso(i), load } : null)).filter(Boolean)
  const bal = rows => loadBalance(rows, { now: NOW, value: m => m.load, fill: true })

  it('accepts a three-day-a-week lifter, who has no coverage to speak of', () => {
    // Twelve training days in a 28-day window. The unfilled guard wants seventeen, so this
    // is exactly the history the strain rules would have thrown out.
    const rows = sessions(60, 2, 400)
    expect(loadBalance(rows, { now: NOW, value: m => m.load }).ok).toBe(false)
    expect(bal(rows).ok).toBe(true)
  })

  it('tells a heavier week from a lighter one by how often you trained, not just how hard', () => {
    // Same session load, twice the sessions. Averaging over training days alone would call
    // these two weeks identical.
    const often = [...sessions(60, 1, 400)]
    const rarely = [...sessions(60, 3, 400)]
    expect(bal(often).acute).toBeGreaterThan(bal(rarely).acute * 2)
  })

  it('reads a week off as easing off rather than as missing data', () => {
    const rows = sessions(60, 2, 400).filter(m => dayMsOf(m.d) < NOW - 7 * DAY)
    const r = bal(rows)
    expect(r.ok).toBe(true)
    expect(r.acute).toBe(0)
    expect(r.band.key).toBe('easing')
  })

  it('still refuses a history that does not reach across the chronic window', () => {
    expect(bal(sessions(20, 2, 400)).ok).toBe(false)
    expect(bal([]).ok).toBe(false)
  })

  it('refuses rather than divide by a month of nothing', () => {
    expect(bal(sessions(60, 2, 0)).ok).toBe(false)
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

describe('liftingLoad', () => {
  // A lifting session `back` days ago: `mins` long, ten sets of w x r, optionally rated.
  const sess = (back, { mins = 60, rpe = null, w = 100, r = 5 } = {}) => {
    const start = NOW - back * DAY
    return {
      id: 'w' + back, d: iso(back), start, end: start + mins * 60000,
      entries: [{ id: 'bench', sets: Array.from({ length: 10 }, () => ({ w, r, done: true, ...(rpe ? { rpe } : {}) })) }],
    }
  }
  const history = f => ({ workouts: Array.from({ length: 30 }, (_, i) => sess(i, f(i))) })

  it('runs the load reads over the barbell half, on sRPE where the history is rated', () => {
    const r = liftingLoad(history(() => ({ rpe: 8 })), { now: NOW })
    expect(r.ok).toBe(true)
    expect(r.basis).toBe('srpe')
    expect(r.unit).toBe('AU')
    expect(r.balance.ok).toBe(true)
    // steady training: this week's average equals the month's
    expect(r.balance.ratio).toBe(1)
    expect(r.balance.acute).toBe(480)
    expect(r.weekly.reduce((a, x) => a + x.days, 0)).toBe(30)
  })

  it('reads a ramp as a ramp, off the lifting series alone', () => {
    // Last week is heavier than the month behind it. No Whoop data anywhere near this.
    const r = liftingLoad(history(i => ({ rpe: i < 7 ? 9 : 6, mins: i < 7 ? 90 : 60 })), { now: NOW })
    expect(r.balance.ratio).toBeGreaterThan(1.3)
    expect(r.balance.band.key).toBe('ramping')
  })

  it('falls back to volume load and says so', () => {
    const r = liftingLoad(history(() => ({})), { now: NOW })
    expect(r.basis).toBe('volume')
    expect(r.unit).toBe('volume')
    expect(r.balance.acute).toBe(5000)
    // ...and reports how close the profile came to the better basis
    expect(r.rated).toBe(0)
    expect(r.sessions).toBe(28)
  })

  it('refuses a history too thin to say anything', () => {
    expect(liftingLoad({ workouts: [] }, { now: NOW }).ok).toBe(false)
    expect(liftingLoad({}, { now: NOW }).ok).toBe(false)
    expect(liftingLoad(null, { now: NOW }).ok).toBe(false)
  })

  it('never mixes a lifting load into the Whoop strain series', () => {
    // The two are different units. Whoop strain is untouched by a month of barbell work.
    const S = { workouts: history(() => ({ rpe: 8 })).workouts, metrics: days(30, () => ({ strain: 9 })) }
    const d = trendDetail(S, { now: NOW })
    expect(d.load.acute).toBe(9)
    expect(d.lifting.balance.acute).toBe(480)
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

  it('refuses only when neither half has anything', () => {
    expect(trendDetail({ metrics: [] }, { now: NOW })).toEqual({ ok: false, missing: ['metrics', 'workouts'] })
    expect(trendDetail(null, { now: NOW }).ok).toBe(false)
  })

  it('never throws on a malformed series', () => {
    for (const m of [[{}], [{ d: 'nope' }], [{ d: iso(1), strain: null }]]) {
      expect(() => trendDetail({ metrics: m }, { now: NOW })).not.toThrow()
    }
  })
})
