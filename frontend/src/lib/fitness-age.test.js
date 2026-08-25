import { describe, it, expect } from 'vitest'
import {
  chronoAge, hrMax, vo2FromRestingHr, vdot, normVo2, fitnessAgeFromVo2, isRunLike,
  bestRunVo2, nameResolver, estimateVo2, fitnessAgeReport, HUNT3, AGE_FLOOR, AGE_CEIL,
} from './fitness-age.js'

const DAY = 86400000
const NOW = Date.parse('2026-08-25T12:00:00Z')

/* Workouts are built against NOW with explicit `start` stamps rather than ISO dates, so
   the window arithmetic is not quietly testing the runner's timezone. */
const run = (daysAgo, sets, name = 'run') => ({
  d: new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10),
  start: NOW - daysAgo * DAY,
  entries: [{ id: name, sets }],
})
const nameOf = id => id

describe('chronoAge', () => {
  it('gives fractional years', () => {
    expect(chronoAge('1990-08-25', NOW)).toBeCloseTo(36, 0)
  })
  it('is fractional, not floored — the delta is often only a few years wide', () => {
    const half = chronoAge('1990-02-25', NOW)
    expect(half).toBeGreaterThan(36.4)
    expect(half).toBeLessThan(36.6)
  })
  it('refuses a birth date in the future', () => {
    expect(chronoAge('2030-01-01', NOW)).toBeNull()
  })
  it('refuses ages the adult curve says nothing about', () => {
    expect(chronoAge('2020-01-01', NOW)).toBeNull()   // 6 years old
    expect(chronoAge('1900-01-01', NOW)).toBeNull()   // 126
  })
  it('refuses junk rather than coercing it', () => {
    for (const v of ['', null, undefined, 'not a date', 42]) expect(chronoAge(v, NOW)).toBeNull()
  })
})

describe('hrMax — Tanaka et al. 2001', () => {
  it('matches 208 - 0.7 x age', () => {
    expect(hrMax(20)).toBeCloseTo(194, 1)
    expect(hrMax(30)).toBeCloseTo(187, 1)
    expect(hrMax(50)).toBeCloseTo(173, 1)
  })
  it('reads higher than "220 - age" for older adults, which is the point of it', () => {
    expect(hrMax(65)).toBeGreaterThan(220 - 65)
  })
  it('refuses ages outside the fitted range', () => {
    expect(hrMax(5)).toBeNull()
    expect(hrMax(120)).toBeNull()
  })
})

describe('vo2FromRestingHr — Uth et al. 2004', () => {
  it('matches 15.3 x HRmax/HRrest', () => {
    // age 30 -> HRmax 187; 15.3 * 187/60 = 47.685
    expect(vo2FromRestingHr(60, 30)).toBeCloseTo(47.7, 1)
  })
  it('rises as resting heart rate falls', () => {
    expect(vo2FromRestingHr(45, 30)).toBeGreaterThan(vo2FromRestingHr(70, 30))
  })
  it('rejects a mistyped resting heart rate instead of returning a VO2max of 300', () => {
    expect(vo2FromRestingHr(6, 30)).toBeNull()     // dropped a zero
    expect(vo2FromRestingHr(600, 30)).toBeNull()
    expect(vo2FromRestingHr(140, 30)).toBeNull()   // not a resting rate
  })
  it('needs a usable age', () => {
    expect(vo2FromRestingHr(60, null)).toBeNull()
  })
})

describe('vdot — Daniels & Gilbert 1979', () => {
  /* Reference points read off Daniels' published VDOT table: a 5 km in 19:57 is VDOT 50,
     and 24:08 is VDOT 40. Asserting against the table rather than against this module's
     own output is the whole value of the test — otherwise it only proves the code equals
     itself. */
  it('puts a 20:00 5 km at VDOT ~50', () => {
    expect(vdot(5000, 20)).toBeCloseTo(50, 0)
  })
  it('puts a 24:08 5 km at VDOT ~40', () => {
    expect(vdot(5000, 24.13)).toBeCloseTo(40, 0)
  })
  it('puts a 41:21 10 km at VDOT ~50, the same runner over twice the distance', () => {
    expect(vdot(10000, 41.35)).toBeCloseTo(50, 0)
  })
  it('rewards the same distance done faster', () => {
    expect(vdot(5000, 18)).toBeGreaterThan(vdot(5000, 22))
  })
  it('refuses nonsense rather than returning a number', () => {
    expect(vdot(0, 20)).toBeNull()
    expect(vdot(5000, 0)).toBeNull()
    expect(vdot(-100, 20)).toBeNull()
    expect(vdot(NaN, 20)).toBeNull()
  })
})

describe('normVo2 — HUNT3 population means', () => {
  it('returns the published mean at every band midpoint', () => {
    for (const sex of ['male', 'female']) {
      for (const [age, vo2] of HUNT3[sex]) expect(normVo2(age, sex)).toBeCloseTo(vo2, 1)
    }
  })
  it('interpolates between anchors', () => {
    expect(normVo2(30, 'male')).toBeCloseTo(51.5, 1)   // midway 54 -> 49
  })
  it('keeps the two sexes on separate curves', () => {
    expect(normVo2(35, 'male')).toBe(49)
    expect(normVo2(35, 'female')).toBe(40)
  })
  it('falls with age', () => {
    expect(normVo2(25, 'male')).toBeGreaterThan(normVo2(65, 'male'))
  })
  it('returns null for an unknown curve', () => {
    expect(normVo2(30, 'other')).toBeNull()
    expect(normVo2(30, undefined)).toBeNull()
  })
})

describe('fitnessAgeFromVo2', () => {
  it('round-trips every published anchor back to its own age', () => {
    for (const sex of ['male', 'female']) {
      for (const [age, vo2] of HUNT3[sex]) {
        expect(fitnessAgeFromVo2(vo2, sex).age).toBeCloseTo(age, 1)
      }
    }
  })
  it('round-trips an interpolated point', () => {
    expect(fitnessAgeFromVo2(normVo2(42, 'female'), 'female').age).toBeCloseTo(42, 0)
  })
  it('does not flag a value inside the table as extrapolated', () => {
    const r = fitnessAgeFromVo2(45, 'male')
    expect(r.extrapolated).toBe(false)
    expect(r.clamped).toBeNull()
  })
  it('flags a value above the youngest band and caps the age', () => {
    // 70 ml/kg/min beats the 20-29 male mean of 54; the honest answer is "off the top of
    // the table", not a confident 14-year-old.
    const r = fitnessAgeFromVo2(70, 'male')
    expect(r.extrapolated).toBe(true)
    expect(r.clamped).toBe('young')
    expect(r.age).toBe(AGE_FLOOR)
  })
  it('flags a value below the oldest band and caps the age', () => {
    const r = fitnessAgeFromVo2(12, 'female')
    expect(r.extrapolated).toBe(true)
    expect(r.clamped).toBe('old')
    expect(r.age).toBe(AGE_CEIL)
  })
  it('is monotonic — more fitness never reads as older', () => {
    let prev = Infinity
    for (let v = 20; v <= 60; v += 2) {
      const a = fitnessAgeFromVo2(v, 'male').age
      expect(a).toBeLessThanOrEqual(prev)
      prev = a
    }
  })
  it('refuses a nonsense VO2max', () => {
    expect(fitnessAgeFromVo2(0, 'male')).toBeNull()
    expect(fitnessAgeFromVo2(-5, 'male')).toBeNull()
    expect(fitnessAgeFromVo2(45, 'nope')).toBeNull()
  })
})

describe('isRunLike', () => {
  it('accepts running under the names people actually log', () => {
    for (const n of ['run', 'Running', 'Run (equipment)', 'short stride run', 'jog',
      'Treadmill', 'sprint intervals', 'parkrun', 'Marathon']) {
      expect(isRunLike(n)).toBe(true)
    }
  })
  it('rejects the catalogue entries that contain "run" but are not running', () => {
    // These are real names from the bundled exercise DB and from Whoop exports. Each one
    // would sail through a naive substring match and be fed to a *running* oxygen-cost
    // equation, which is exactly how a cycling hour becomes a fake VO2max.
    for (const n of ['stationary bike run v. 3', 'wheel run', 'push to run']) {
      expect(isRunLike(n)).toBe(false)
    }
  })
  it('rejects walking, including on a treadmill', () => {
    // Walking economy differs enough that Daniels does not transfer.
    expect(isRunLike('walking on incline treadmill')).toBe(false)
    expect(isRunLike('walking on stepmill')).toBe(false)
  })
  it('rejects other cardio outright', () => {
    for (const n of ['Cycling', 'cycle cross trainer', 'Rowing', 'Swimming', 'jump rope',
      'burpee', 'mountain climber', 'walk elliptical cross trainer', 'Hiking']) {
      expect(isRunLike(n)).toBe(false)
    }
  })
  it('handles empty input', () => {
    expect(isRunLike('')).toBe(false)
    expect(isRunLike(null)).toBe(false)
  })
})

describe('bestRunVo2', () => {
  it('reads a qualifying run', () => {
    const best = bestRunVo2([run(3, [{ min: 20, speed: 15, done: true }])], { now: NOW, nameOf })
    expect(best.vo2).toBeCloseTo(vdot(5000, 20), 1)   // 15 km/h for 20 min = 5 km
    expect(best.min).toBe(20)
  })
  it('takes the hardest effort, not the most recent', () => {
    // An easy jog logged yesterday must not bury a hard tempo from last week: only the
    // hard one says anything about capacity.
    const best = bestRunVo2([
      run(7, [{ min: 20, speed: 15, done: true }]),
      run(1, [{ min: 40, speed: 9, done: true }]),
    ], { now: NOW, nameOf })
    expect(best.kmh).toBe(15)
  })
  it('ignores anything outside the window', () => {
    expect(bestRunVo2([run(200, [{ min: 20, speed: 15, done: true }])], { now: NOW, nameOf })).toBeNull()
    expect(bestRunVo2([run(200, [{ min: 20, speed: 15, done: true }])], { now: NOW, nameOf, days: 365 })).not.toBeNull()
  })
  it('ignores a cycling session even at a plausible-looking speed', () => {
    // 30 km/h is an ordinary bike pace and a superhuman run. The equation cannot tell,
    // so the name has to.
    const w = run(2, [{ min: 45, speed: 30, done: true }], 'Cycling')
    expect(bestRunVo2([w], { now: NOW, nameOf })).toBeNull()
  })
  it('ignores a run too short to be a test', () => {
    expect(bestRunVo2([run(2, [{ min: 4, speed: 15, done: true }])], { now: NOW, nameOf })).toBeNull()
  })
  it('ignores speeds outside what a sustained run can be', () => {
    expect(bestRunVo2([run(2, [{ min: 20, speed: 4, done: true }])], { now: NOW, nameOf })).toBeNull()   // walking
    expect(bestRunVo2([run(2, [{ min: 20, speed: 40, done: true }])], { now: NOW, nameOf })).toBeNull()  // mislabelled bike
  })
  it('ignores sets that were never completed', () => {
    expect(bestRunVo2([run(2, [{ min: 20, speed: 15, done: false }])], { now: NOW, nameOf })).toBeNull()
  })
  it('survives missing or malformed entries', () => {
    expect(bestRunVo2([{ d: '2026-08-01' }, { entries: [{ id: 'run' }] }], { now: NOW, nameOf })).toBeNull()
    expect(bestRunVo2(null, { now: NOW, nameOf })).toBeNull()
    expect(bestRunVo2([], { now: NOW })).toBeNull()   // no resolver
  })
})

describe('nameResolver', () => {
  it('prefers the profile custom over the catalogue', () => {
    const r = nameResolver({ customEx: [{ id: 'im1', n: 'Cycling' }] }, { im1: { n: 'run' } })
    expect(r('im1')).toBe('Cycling')
  })
  it('falls back to the catalogue, then to empty', () => {
    const r = nameResolver({}, { '0685': { n: 'run' } })
    expect(r('0685')).toBe('run')
    expect(r('nope')).toBe('')
  })
})

describe('estimateVo2 — priority', () => {
  const base = { birth: '1991-08-25', workouts: [run(3, [{ min: 20, speed: 15, done: true }])] }

  it('prefers a measured value over everything inferred', () => {
    const e = estimateVo2({ ...base, vo2max: 52, restHr: 55 }, { now: NOW, nameOf })
    expect(e.source).toBe('entered')
    expect(e.vo2).toBe(52)
    expect(e.others.map(o => o.source)).toEqual(['run', 'restingHr'])
  })
  it('prefers a run the user actually ran over a single heart-rate reading', () => {
    const e = estimateVo2({ ...base, restHr: 55 }, { now: NOW, nameOf })
    expect(e.source).toBe('run')
    expect(e.floor).toBe(true)
    expect(e.others.map(o => o.source)).toEqual(['restingHr'])
  })
  it('falls back to resting heart rate, flagged rough', () => {
    const e = estimateVo2({ birth: base.birth, workouts: [], restHr: 55 }, { now: NOW, nameOf })
    expect(e.source).toBe('restingHr')
    expect(e.rough).toBe(true)
    expect(e.others).toEqual([])
  })
  it('returns null when there is nothing to go on', () => {
    expect(estimateVo2({ birth: base.birth, workouts: [] }, { now: NOW, nameOf })).toBeNull()
  })
  it('rejects an implausible entered VO2max instead of trusting the typist', () => {
    expect(estimateVo2({ birth: base.birth, workouts: [], vo2max: 300 }, { now: NOW, nameOf })).toBeNull()
    expect(estimateVo2({ birth: base.birth, workouts: [], vo2max: 3 }, { now: NOW, nameOf })).toBeNull()
  })
})

describe('fitnessAgeReport', () => {
  const ok = { birth: '1991-08-25', physSex: 'male', vo2max: 54, workouts: [] }

  it('reports a fit 35-year-old as younger than their age', () => {
    // VO2max 54 is the published mean for a 20-29 man, so a 35-year-old holding it should
    // read as roughly 25 — ten years younger.
    const r = fitnessAgeReport(ok, { now: NOW, nameOf })
    expect(r.ok).toBe(true)
    expect(r.chrono).toBeCloseTo(35, 0)
    expect(r.fitness).toBeCloseTo(25, 0)
    expect(r.delta).toBeLessThan(-9)
    expect(r.norm).toBe(49)
    expect(r.source).toBe('entered')
  })

  it('reports an unfit person as older, with a positive delta', () => {
    const r = fitnessAgeReport({ ...ok, vo2max: 39 }, { now: NOW, nameOf })
    expect(r.fitness).toBeCloseTo(65, 0)
    expect(r.delta).toBeGreaterThan(29)
  })

  it('puts someone exactly on their own curve at delta ~0', () => {
    const r = fitnessAgeReport({ ...ok, vo2max: normVo2(35, 'male') }, { now: NOW, nameOf })
    expect(Math.abs(r.delta)).toBeLessThan(0.6)
  })

  it('uses the same VO2max on both sides — sex changes the answer', () => {
    const m = fitnessAgeReport({ ...ok, vo2max: 43 }, { now: NOW, nameOf })
    const f = fitnessAgeReport({ ...ok, physSex: 'female', vo2max: 43 }, { now: NOW, nameOf })
    expect(f.fitness).toBeLessThan(m.fitness)   // 43 is the 20-29 female mean, a mid-50s male one
  })

  it('carries the run detail through when the run is the source', () => {
    const r = fitnessAgeReport({
      birth: ok.birth, physSex: 'male',
      workouts: [run(5, [{ min: 20, speed: 15, done: true }])],
    }, { now: NOW, nameOf })
    expect(r.source).toBe('run')
    expect(r.floor).toBe(true)
    expect(r.run.kmh).toBe(15)
  })

  it('names a missing birth date rather than assuming one', () => {
    const r = fitnessAgeReport({ physSex: 'male', vo2max: 50 }, { now: NOW, nameOf })
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('birth')
  })

  it('names a missing reference curve — it must never be guessed', () => {
    const r = fitnessAgeReport({ birth: ok.birth, vo2max: 50 }, { now: NOW, nameOf })
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('physSex')
  })

  it('does not accept the body-map preference as a reference curve', () => {
    // `body` picks which muscle diagram to draw. Reading it as physiology would move a
    // fitness age by more than a decade without ever asking.
    const r = fitnessAgeReport({ birth: ok.birth, body: 'male', vo2max: 50 }, { now: NOW, nameOf })
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('physSex')
  })

  it('names a missing VO2max', () => {
    const r = fitnessAgeReport({ birth: ok.birth, physSex: 'male', workouts: [] }, { now: NOW, nameOf })
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['vo2'])
  })

  it('lists every missing input at once, so the sheet can ask for all of them', () => {
    const r = fitnessAgeReport({}, { now: NOW, nameOf })
    expect(r.ok).toBe(false)
    expect(r.missing.sort()).toEqual(['birth', 'physSex', 'vo2'])
  })

  it('never throws on an empty or malformed profile', () => {
    for (const s of [null, undefined, {}, { workouts: null }, { birth: 'x', physSex: 'y' }]) {
      expect(() => fitnessAgeReport(s, { now: NOW, nameOf })).not.toThrow()
      expect(fitnessAgeReport(s, { now: NOW, nameOf }).ok).toBe(false)
    }
  })
})
