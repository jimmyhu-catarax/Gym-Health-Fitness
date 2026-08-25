import { describe, it, expect } from 'vitest'
import {
  erf, normCdf, mean, stdev, cleanRr, rmssd, hrReserve, banisterTrimp, trimpFromAverage,
  trimpToStrain, recoveryScore, recoveryFor, withComputedRecovery, recoveryZone,
  TRIMP_COEF, RECOVERY_MIN_DAYS,
} from './physiology.js'

describe('erf / normCdf', () => {
  // Reference values from standard tables — the point of the approximation is that it agrees
  // with them, so that is what is asserted rather than whatever this implementation returns.
  it('matches published erf values', () => {
    expect(erf(0)).toBeCloseTo(0, 6)
    expect(erf(0.5)).toBeCloseTo(0.5204999, 5)
    expect(erf(1)).toBeCloseTo(0.8427008, 5)
    expect(erf(2)).toBeCloseTo(0.9953223, 5)
  })
  it('is odd', () => {
    for (const x of [0.3, 1, 2.5]) expect(erf(-x)).toBeCloseTo(-erf(x), 9)
  })
  it('gives the standard normal CDF', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6)
    expect(normCdf(1.6448536)).toBeCloseTo(0.95, 4)   // 95th percentile
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 4)   // 97.5th
    expect(normCdf(-1.959964)).toBeCloseTo(0.025, 4)
  })
})

describe('mean / stdev', () => {
  it('computes both', () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(stdev([2, 4, 6])).toBeCloseTo(Math.sqrt(8 / 3), 6)
  })
  it('refuses a standard deviation of one point', () => {
    expect(stdev([5])).toBeNaN()
  })
})

describe('cleanRr', () => {
  it('keeps a clean series intact', () => {
    const rr = [1000, 1010, 995, 1005, 1002]
    expect(cleanRr(rr)).toEqual(rr)
  })
  it('drops physiologically impossible intervals', () => {
    expect(cleanRr([1000, 250, 1010, 2500, 1005])).not.toContain(250)
    expect(cleanRr([1000, 250, 1010, 2500, 1005])).not.toContain(2500)
  })
  it('drops a missed beat, which reads as a doubled interval', () => {
    // 2000 is inside the absolute bounds and looks like a plausible 30 bpm on its own. It is
    // only wrong in sequence — and left in, it inflates rMSSD enough to turn a bad night green.
    const out = cleanRr([1000, 1010, 2000, 1005, 1000])
    expect(out).not.toContain(2000)
  })
  it('returns empty rather than guessing on too little data', () => {
    expect(cleanRr([1000])).toEqual([])
    expect(cleanRr([])).toEqual([])
    expect(cleanRr(null)).toEqual([])
  })
})

describe('rmssd', () => {
  it('is zero for a perfectly regular heart', () => {
    expect(rmssd([1000, 1000, 1000, 1000])).toBe(0)
  })
  it('matches a hand-computed example', () => {
    // diffs 10, -20, 30 -> sqrt((100+400+900)/3) = sqrt(466.67) = 21.6
    expect(rmssd([1000, 1010, 990, 1020])).toBeCloseTo(21.6, 1)
  })
  it('rises with variability', () => {
    expect(rmssd([1000, 1050, 950, 1060])).toBeGreaterThan(rmssd([1000, 1005, 995, 1002]))
  })
  it('needs at least two intervals', () => {
    expect(rmssd([1000])).toBeNull()
    expect(rmssd([])).toBeNull()
  })
})

describe('hrReserve', () => {
  it('is the fraction between rest and max', () => {
    expect(hrReserve(120, 60, 180)).toBeCloseTo(0.5, 6)
    expect(hrReserve(60, 60, 180)).toBe(0)
    expect(hrReserve(180, 60, 180)).toBe(1)
  })
  it('clamps rather than letting a spike exceed max', () => {
    expect(hrReserve(220, 60, 180)).toBe(1)
    expect(hrReserve(40, 60, 180)).toBe(0)
  })
  it('refuses an impossible rest/max pair', () => {
    expect(hrReserve(120, 180, 60)).toBe(0)
  })
})

describe('banisterTrimp', () => {
  const opts = { rest: 50, max: 190, hz: 1 }

  it('matches the formula on a hand-checkable case', () => {
    // 60 samples at 1 Hz = 1 minute, HR 120 -> d = 70/140 = 0.5
    // TRIMP = 1 * 0.5 * 0.64 * e^(1.92*0.5) = 0.32 * 2.6117 = 0.8357
    const hr = Array(60).fill(120)
    expect(banisterTrimp(hr, opts)).toBeCloseTo(0.8, 1)
  })

  it('grows with duration', () => {
    const a = banisterTrimp(Array(60).fill(140), opts)
    const b = banisterTrimp(Array(120).fill(140), opts)
    expect(b).toBeCloseTo(a * 2, 1)
  })

  it('grows faster than linearly with intensity — the whole reason for the exponent', () => {
    // Same total beats-above-rest, different distribution. A linear time-in-zone model would
    // score these equally; Banister must not.
    const steady = banisterTrimp(Array(120).fill(120), opts)
    const split = banisterTrimp([...Array(60).fill(90), ...Array(60).fill(150)], opts)
    expect(split).toBeGreaterThan(steady)
  })

  it('uses the sex-specific coefficients', () => {
    const hr = Array(600).fill(150)
    const m = banisterTrimp(hr, { ...opts, sex: 'male' })
    const f = banisterTrimp(hr, { ...opts, sex: 'female' })
    expect(m).not.toBeCloseTo(f, 1)
    expect(TRIMP_COEF.female.y).toBeGreaterThan(TRIMP_COEF.male.y)
    expect(TRIMP_COEF.female.b).toBeLessThan(TRIMP_COEF.male.b)
  })

  it('accounts for the sample rate', () => {
    const hr = Array(120).fill(130)
    expect(banisterTrimp(hr, { ...opts, hz: 2 })).toBeCloseTo(banisterTrimp(Array(60).fill(130), opts), 2)
  })

  it('refuses nonsense instead of returning a number', () => {
    expect(banisterTrimp([], opts)).toBeNull()
    expect(banisterTrimp(null, opts)).toBeNull()
    expect(banisterTrimp([120], { rest: 190, max: 50 })).toBeNull()
    expect(banisterTrimp([120], { ...opts, hz: 0 })).toBeNull()
  })
})

describe('trimpFromAverage', () => {
  it('agrees with the series form when the series is flat', () => {
    const opts = { rest: 50, max: 190 }
    const series = banisterTrimp(Array(600).fill(140), { ...opts, hz: 1 })
    expect(trimpFromAverage(140, 10, opts)).toBeCloseTo(series, 1)
  })
  it('understates a variable session, per Jensen', () => {
    // The coarse path cannot see the intervals, and e^mean < mean of e^. This is exactly why
    // callers must label it rather than mix it with a series-derived value.
    const opts = { rest: 50, max: 190 }
    const varied = banisterTrimp([...Array(300).fill(100), ...Array(300).fill(180)], { ...opts, hz: 1 })
    expect(trimpFromAverage(140, 10, opts)).toBeLessThan(varied)
  })
  it('refuses missing inputs', () => {
    expect(trimpFromAverage(140, 0, { rest: 50, max: 190 })).toBeNull()
    expect(trimpFromAverage(NaN, 10, { rest: 50, max: 190 })).toBeNull()
  })
})

describe('trimpToStrain', () => {
  it('starts at zero and never reaches the ceiling', () => {
    expect(trimpToStrain(0)).toBe(0)
    expect(trimpToStrain(1e6)).toBeLessThanOrEqual(21)
    expect(trimpToStrain(1e6)).toBeGreaterThan(20.9)
  })
  it('puts an exhaustive endurance session near the top', () => {
    // TRIMP ~300 is the "brutal" end of the scale; it should read ~20, not 12 and not pinned.
    expect(trimpToStrain(300)).toBeGreaterThan(20)
    expect(trimpToStrain(300)).toBeLessThan(21)
  })
  it('is monotonic with diminishing returns', () => {
    const a = trimpToStrain(50), b = trimpToStrain(100), c = trimpToStrain(150)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
    expect(c - b).toBeLessThan(b - a)
  })
  it('refuses nonsense', () => {
    expect(trimpToStrain(-1)).toBeNull()
    expect(trimpToStrain(NaN)).toBeNull()
  })
})

describe('recoveryScore', () => {
  const base = n => Array.from({ length: n }, (_, i) => 50 + (i % 5))       // HRV around 52
  const rbase = n => Array.from({ length: n }, (_, i) => 55 + (i % 3))      // RHR around 56

  it('reads high when HRV is above baseline and RHR below', () => {
    const r = recoveryScore({ hrv: 75, rhr: 50, hrvBase: base(28), rhrBase: rbase(28) })
    expect(r.pct).toBeGreaterThan(66)
    expect(r.zone).toBe('green')
  })

  it('reads low when HRV collapses and RHR climbs', () => {
    const r = recoveryScore({ hrv: 32, rhr: 64, hrvBase: base(28), rhrBase: rbase(28) })
    expect(r.pct).toBeLessThan(34)
    expect(r.zone).toBe('red')
  })

  it('sits near the middle when today is the baseline', () => {
    const r = recoveryScore({ hrv: 52, rhr: 56, hrvBase: base(28), rhrBase: rbase(28) })
    expect(Math.abs(r.pct - 50)).toBeLessThan(15)
  })

  it('treats a raised resting heart rate as a cost, not a credit', () => {
    const lo = recoveryScore({ hrv: 52, rhr: 50, hrvBase: base(28), rhrBase: rbase(28) })
    const hi = recoveryScore({ hrv: 52, rhr: 65, hrvBase: base(28), rhrBase: rbase(28) })
    expect(hi.pct).toBeLessThan(lo.pct)
  })

  it('refuses a baseline too short to mean anything', () => {
    expect(recoveryScore({ hrv: 60, rhr: 52, hrvBase: base(3), rhrBase: rbase(3) })).toBeNull()
    expect(recoveryScore({ hrv: 60, rhr: 52, hrvBase: [], rhrBase: [] })).toBeNull()
  })

  it('works from HRV alone, renormalised rather than dragged toward the middle', () => {
    const r = recoveryScore({ hrv: 75, hrvBase: base(28) })
    expect(r.inputs).toEqual(['hrv'])
    expect(r.pct).toBeGreaterThan(66)   // a lone strong signal must still reach green
  })

  it('works from resting heart rate alone', () => {
    const r = recoveryScore({ rhr: 48, rhrBase: rbase(28) })
    expect(r.inputs).toEqual(['rhr'])
    expect(r.pct).toBeGreaterThan(50)
  })

  it('refuses a baseline with no variance rather than dividing by zero', () => {
    expect(recoveryScore({ hrv: 60, hrvBase: Array(28).fill(50) })).toBeNull()
  })

  it('never returns 0 or 100 — no day is certain', () => {
    const r = recoveryScore({ hrv: 300, rhr: 25, hrvBase: base(28), rhrBase: rbase(28) })
    expect(r.pct).toBeLessThanOrEqual(99)
    expect(r.pct).toBeGreaterThanOrEqual(1)
  })

  it('uses the log transform, so symmetry lives in ratios and not in milliseconds', () => {
    // Baseline built to be symmetric in LOG space around exp(3.9) ~ 49.4 ms, and spread
    // widely enough that the probes do not saturate at 1/99 — a tight baseline pins both
    // ends and hides the very asymmetry this is checking.
    const lnBase = [3.6, 3.7, 3.8, 3.9, 4.0, 4.1, 4.2]
    const hrvBase = Array.from({ length: 28 }, (_, i) => Math.exp(lnBase[i % 7]))
    const G = Math.exp(3.9)

    // Equidistant in log space (same ratio up and down) -> symmetric about 50.
    const rUp = recoveryScore({ hrv: G * Math.exp(0.2), hrvBase }).pct
    const rDn = recoveryScore({ hrv: G * Math.exp(-0.2), hrvBase }).pct
    expect(rUp + rDn).toBeCloseTo(100, 0)

    // Equidistant in raw milliseconds -> NOT symmetric, because the same number of ms is a
    // bigger relative move downward. This is the whole reason for the transform.
    const up = recoveryScore({ hrv: G + 15, hrvBase }).pct - 50
    const dn = 50 - recoveryScore({ hrv: G - 15, hrvBase }).pct
    expect(dn).toBeGreaterThan(up + 2)
  })
})

describe('recoveryZone', () => {
  it('follows the familiar three-colour split', () => {
    expect(recoveryZone(80)).toBe('green')
    expect(recoveryZone(67)).toBe('green')
    expect(recoveryZone(50)).toBe('yellow')
    expect(recoveryZone(34)).toBe('yellow')
    expect(recoveryZone(20)).toBe('red')
  })
})

describe('recoveryFor', () => {
  const series = Array.from({ length: 40 }, (_, i) => ({
    d: `2026-07-${String(i + 1).padStart(2, '0')}`, hrv: 50 + (i % 5), rhr: 55 + (i % 3),
  }))

  it('scores a day against the days before it', () => {
    const r = recoveryFor(series, series[30].d)
    expect(r).not.toBeNull()
    expect(r.pct).toBeGreaterThan(0)
  })

  it('excludes the day itself from its own baseline', () => {
    // A day that contributes to its own baseline is compared against itself and drifts toward
    // the middle. Spike one day hugely: if it were in its own baseline, it would barely move.
    const spiked = series.map((m, i) => (i === 30 ? { ...m, hrv: 200 } : m))
    expect(recoveryFor(spiked, spiked[30].d).pct).toBeGreaterThan(90)
  })

  it('refuses a day too early to have a baseline', () => {
    expect(recoveryFor(series, series[2].d)).toBeNull()
  })

  it('returns null for a day that is not in the series', () => {
    expect(recoveryFor(series, '1999-01-01')).toBeNull()
    expect(recoveryFor([], '2026-07-01')).toBeNull()
  })
})

describe('withComputedRecovery', () => {
  const series = Array.from({ length: 40 }, (_, i) => ({
    d: `2026-07-${String(i + 1).padStart(2, '0')}`, hrv: 50 + (i % 5), rhr: 55 + (i % 3),
  }))

  it('never overwrites a score Whoop supplied', () => {
    const withScore = series.map((m, i) => (i === 30 ? { ...m, recovery: 42 } : m))
    const out = withComputedRecovery(withScore)
    expect(out[30].recovery).toBe(42)
    expect(out[30].recoverySrc).toBe('whoop')
  })

  it('fills the gaps and says the value is computed', () => {
    const out = withComputedRecovery(series)
    expect(out[30].recovery).toBeGreaterThan(0)
    expect(out[30].recoverySrc).toBe('computed')
  })

  it('leaves early days alone rather than inventing a baseline', () => {
    const out = withComputedRecovery(series)
    expect(out[1].recovery).toBeUndefined()
    expect(out[1].recoverySrc).toBeUndefined()
  })

  it('survives an empty or malformed series', () => {
    expect(withComputedRecovery([])).toEqual([])
    expect(withComputedRecovery(null)).toEqual([])
  })

  it('needs at least the documented minimum of baseline days', () => {
    expect(RECOVERY_MIN_DAYS).toBeGreaterThanOrEqual(7)
  })
})
