// Fitness age — the age at which your cardiorespiratory fitness would be average.
//
// Whoop, Garmin and NTNU all ship a version of this. The honest version of the idea is
// narrow: VO2max falls with age along a well-measured population curve, so an individual
// VO2max can be read back as "the age at which this value is the mean". That is the whole
// trick. It is NOT a biological age in the clinical sense — those come from epigenetic
// clocks or blood panels (Horvath, Levine's PhenoAge) and no amount of gym logging
// substitutes for them. The UI says so, and so does docs/FITNESS_AGE.md; if this module
// ever starts calling its output "biological age", that is a bug.
//
// Every constant below comes from a published model, named at its use site:
//
//   HUNT3 (Loe et al. 2013; NTNU CERG)  population VO2peak by age band and sex
//   Tanaka et al. 2001                  HRmax = 208 - 0.7 x age
//   Uth et al. 2004                     VO2max = 15.3 x (HRmax / HRrest)
//   Daniels & Gilbert 1979              VDOT from a running distance and time
//
// The module's stance matches lib/import-health.js: a number that is wrong is worse than
// no number. Every path that cannot resolve its inputs returns `missing`, never a guess.

/**
 * HUNT3 mean VO2peak (mL/kg/min) by age band, from ~4,600 Norwegian adults.
 * https://www.ntnu.edu/cerg/fitness-numbers
 *
 * Anchored at band midpoints. The published bands are decades, so 20-29 becomes 25 — the
 * curve between anchors is interpolated, not smoothed: 35->45 falls only 2 points for men
 * while 25->35 falls 5, and flattening that to a tidy "7% per decade" would be inventing
 * data the study did not report.
 */
export const HUNT3 = {
  male: [[25, 54], [35, 49], [45, 47], [55, 42], [65, 39], [75, 34]],
  female: [[25, 43], [35, 40], [45, 38], [55, 34], [65, 31], [75, 27]],
}

/** Ages outside these bounds are reported as clamped rather than extrapolated forever. */
export const AGE_FLOOR = 18
export const AGE_CEIL = 90

export const SEXES = ['male', 'female']

const lerp = (x, x0, y0, x1, y1) => y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)
const round1 = n => Math.round(n * 10) / 10

/**
 * Chronological age in fractional years.
 *
 * Fractional because the whole feature is a comparison of two ages, and rounding one of
 * them to an integer before subtracting puts a year of slop into a delta that is often
 * only a few years wide.
 *
 * @param {string} birth  ISO date, 'YYYY-MM-DD'
 * @returns {number|null} null when unparseable, in the future, or outside 13-100 — the
 *   HUNT curve is an adult curve and says nothing useful about a child.
 */
export function chronoAge(birth, now = Date.now()) {
  if (!birth || typeof birth !== 'string') return null
  const t = Date.parse(birth + (birth.length === 10 ? 'T12:00:00' : ''))
  if (!isFinite(t) || t >= now) return null
  const years = (now - t) / (365.2425 * 86400000)
  if (years < 13 || years > 100) return null
  return round1(years)
}

/**
 * Population mean VO2peak for an age and sex, interpolated across the HUNT3 anchors.
 * Outside the anchor range the nearest segment's slope is continued — flagged by the
 * callers that care, because it is extrapolation and not measurement.
 */
export function normVo2(age, sex) {
  const tbl = HUNT3[sex]
  if (!tbl || !isFinite(age)) return null
  if (age <= tbl[0][0]) return round1(lerp(age, tbl[0][0], tbl[0][1], tbl[1][0], tbl[1][1]))
  const last = tbl.length - 1
  if (age >= tbl[last][0]) {
    return round1(lerp(age, tbl[last - 1][0], tbl[last - 1][1], tbl[last][0], tbl[last][1]))
  }
  for (let i = 0; i < last; i++) {
    const [a0, v0] = tbl[i], [a1, v1] = tbl[i + 1]
    if (age >= a0 && age <= a1) return round1(lerp(age, a0, v0, a1, v1))
  }
  return null
}

/**
 * Invert the curve: the age whose mean VO2peak equals this one.
 *
 * @returns {{age:number, extrapolated:boolean, clamped:'young'|'old'|null}|null}
 *   `extrapolated` means the value sits off the ends of the published table — a very fit
 *   30-year-old man beats the 20-29 mean, and the only truthful answer there is "younger
 *   than the youngest band we have numbers for", not a confident 14.
 */
export function fitnessAgeFromVo2(vo2, sex) {
  const tbl = HUNT3[sex]
  if (!tbl || !isFinite(vo2) || vo2 <= 0) return null
  const last = tbl.length - 1
  let age = null, extrapolated = false

  if (vo2 >= tbl[0][1]) {
    age = lerp(vo2, tbl[0][1], tbl[0][0], tbl[1][1], tbl[1][0])
    extrapolated = vo2 > tbl[0][1]
  } else if (vo2 <= tbl[last][1]) {
    age = lerp(vo2, tbl[last - 1][1], tbl[last - 1][0], tbl[last][1], tbl[last][0])
    extrapolated = vo2 < tbl[last][1]
  } else {
    for (let i = 0; i < last; i++) {
      const [a0, v0] = tbl[i], [a1, v1] = tbl[i + 1]
      // The curve descends, so the band that contains vo2 has v1 <= vo2 <= v0.
      if (vo2 <= v0 && vo2 >= v1) { age = lerp(vo2, v0, a0, v1, a1); break }
    }
  }
  if (age == null) return null

  let clamped = null
  if (age < AGE_FLOOR) { age = AGE_FLOOR; clamped = 'young' }
  else if (age > AGE_CEIL) { age = AGE_CEIL; clamped = 'old' }
  return { age: round1(age), extrapolated, clamped }
}

/**
 * Tanaka et al. 2001, the meta-analytic replacement for "220 - age", which
 * systematically underestimates HRmax in older adults.
 */
export function hrMax(age) {
  if (!isFinite(age) || age < 13 || age > 100) return null
  return round1(208 - 0.7 * age)
}

/**
 * Uth et al. 2004 (Eur J Appl Physiol 93:508-509), the heart-rate ratio method.
 *
 * Derived from the Fick principle rather than fitted to a population, which is why it
 * needs no waist measurement — a real advantage for an app that has never asked for one.
 * The catch, and the reason callers label it `rough`: it was validated on well-trained
 * subjects and reads high for untrained ones. It is the weakest of the three estimators
 * here and is used only when nothing better exists.
 *
 * The 30-120 bpm guard is a typo filter. A resting heart rate of 6 (a mistyped 60) would
 * otherwise sail through as a VO2max of 300.
 */
export function vo2FromRestingHr(restHr, age) {
  const max = hrMax(age)
  if (!max || !isFinite(restHr) || restHr < 30 || restHr > 120) return null
  return round1(15.3 * (max / restHr))
}

/**
 * Daniels & Gilbert, "Oxygen Power" (1979) — VDOT from a running distance and time.
 *
 * Two equations: the oxygen cost of running at a velocity, and the fraction of VO2max a
 * runner can hold for a duration. VDOT is the first divided by the second. It is a
 * "pseudo-VO2max": it folds running economy in with aerobic capacity, so it is not
 * interchangeable with a lab value, but it moves with fitness and that is what this
 * feature reads.
 *
 * @param {number} metres
 * @param {number} minutes
 */
export function vdot(metres, minutes) {
  if (!isFinite(metres) || !isFinite(minutes) || metres <= 0 || minutes <= 0) return null
  const v = metres / minutes                                    // m/min
  const cost = -4.60 + 0.182258 * v + 0.000104 * v * v          // mL/kg/min at that pace
  const pct = 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) +
    0.2989558 * Math.exp(-0.1932605 * minutes)                  // fraction of VO2max held
  if (cost <= 0 || pct <= 0) return null
  return round1(cost / pct)
}

// Whoop imports every cardio activity as a session with a duration and a speed, and the
// built-in catalogue calls one of its exercise bikes "stationary bike run v. 3". Feeding
// either into a *running* oxygen-cost equation is the exact failure lib/import-health.js
// was written to avoid: 30 km/h is a pedestrian cycling pace and a superhuman run, and
// the equation cannot tell. So a session qualifies only if its name reads as running and
// its numbers are physiologically possible for a run.
//
// Negatives win over positives, because the traps all contain a positive: "wheel run",
// "push to run", "stationary bike run", and "walking on incline treadmill" (walking is
// excluded on its own merits — walking economy differs enough that the equation does not
// transfer).
const RUN_NO = [
  'bike', 'cycl', 'spin', 'row', 'swim', 'walk', 'ellipt', 'ski', 'stair', 'stepmill',
  'hike', 'wheel', 'push to', 'rope', 'burpee', 'climber', 'jump', 'jack', 'crawl',
  'hop', 'squat', 'lunge', 'knee', 'sit-up', 'step',
]
const RUN_YES = ['run', 'jog', 'treadmill', 'sprint', 'marathon', 'parkrun', '5k', '10k']

/** Speeds and durations a sustained run can actually have. Outside these, the row is not
 *  a run test however it is named — 25 km/h held for six minutes is a world record pace. */
export const RUN_MIN_MINUTES = 6
export const RUN_MAX_MINUTES = 180
export const RUN_MIN_KMH = 7
export const RUN_MAX_KMH = 25

export function isRunLike(name) {
  const n = String(name || '').toLowerCase()
  if (!n) return false
  if (RUN_NO.some(k => n.includes(k))) return false
  return RUN_YES.some(k => n.includes(k))
}

/**
 * The best VO2max a logged run supports, over a recent window.
 *
 * Deliberately the *maximum* across qualifying sets, not the average or the latest: an
 * easy jog and a hard tempo both land in the log, and only the hard one says anything
 * about capacity. Even so the answer is a floor — the app has no way to know an effort
 * was maximal, and a submaximal run can only understate VO2max. Callers surface that as
 * `floor: true` rather than quietly presenting a lower bound as a measurement.
 *
 * @param {Array} workouts
 * @param {(id:string)=>string} nameOf  resolves an exercise id to its name
 */
export function bestRunVo2(workouts, { now = Date.now(), days = 90, nameOf } = {}) {
  if (!Array.isArray(workouts) || typeof nameOf !== 'function') return null
  const since = now - days * 86400000
  let best = null

  for (const w of workouts) {
    const at = w.start || Date.parse(String(w.d) + 'T12:00:00')
    if (!isFinite(at) || at < since || at > now) continue
    for (const e of w.entries || []) {
      if (!isRunLike(nameOf(e.id))) continue
      for (const s of e.sets || []) {
        if (!s || s.done === false) continue
        const min = Number(s.min), kmh = Number(s.speed)
        if (!(min >= RUN_MIN_MINUTES && min <= RUN_MAX_MINUTES)) continue
        if (!(kmh >= RUN_MIN_KMH && kmh <= RUN_MAX_KMH)) continue
        const v = vdot((kmh * 1000 * min) / 60, min)
        if (v != null && (!best || v > best.vo2)) best = { vo2: v, min, kmh, d: w.d, at }
      }
    }
  }
  return best
}

/** Build the default id -> name resolver from the catalogue plus the profile's customs. */
export function nameResolver(S, EXIDX = {}) {
  const custom = new Map((S && S.customEx ? S.customEx : []).map(c => [c.id, c.n]))
  return id => custom.get(id) || (EXIDX[id] && EXIDX[id].n) || ''
}

/**
 * Pick the best VO2max estimate the profile can support.
 *
 * Priority is by how directly the number was measured, not by how flattering it is:
 * a value the user got from a lab or a watch beats one this app inferred, and an
 * inference from a run the user actually ran beats one from a single resting-heart-rate
 * reading. Estimates that lost the tie-break are still returned in `others`, so the UI
 * can show a disagreement rather than hide it behind the winner.
 */
export function estimateVo2(S, { now = Date.now(), nameOf, days = 90 } = {}) {
  const age = chronoAge(S && S.birth, now)
  const out = []

  const entered = Number(S && S.vo2max)
  if (isFinite(entered) && entered >= 15 && entered <= 90) {
    out.push({ vo2: round1(entered), source: 'entered', floor: false })
  }
  if (age != null && nameOf) {
    const run = bestRunVo2((S && S.workouts) || [], { now, days, nameOf })
    if (run) out.push({ vo2: run.vo2, source: 'run', floor: true, run })
  }
  const hr = vo2FromRestingHr(Number(S && S.restHr), age)
  if (hr != null) out.push({ vo2: hr, source: 'restingHr', floor: false, rough: true })

  if (!out.length) return null
  const RANK = { entered: 0, run: 1, restingHr: 2 }
  out.sort((a, b) => RANK[a.source] - RANK[b.source])
  return { ...out[0], others: out.slice(1) }
}

/**
 * The whole feature in one call.
 *
 * Returns `{ ok: false, missing }` rather than a partial number whenever an input the
 * result depends on is absent. `missing` is a list of field names the UI turns into the
 * specific thing to go and add — "we need your date of birth" beats a dash on a card.
 */
export function fitnessAgeReport(S, { now = Date.now(), nameOf, days = 90 } = {}) {
  const missing = []
  const chrono = chronoAge(S && S.birth, now)
  const sex = S && SEXES.includes(S.physSex) ? S.physSex : null
  if (chrono == null) missing.push('birth')
  if (!sex) missing.push('physSex')

  const est = estimateVo2(S, { now, nameOf, days })
  if (!est) missing.push('vo2')
  if (missing.length) return { ok: false, missing }

  const fa = fitnessAgeFromVo2(est.vo2, sex)
  if (!fa) return { ok: false, missing: ['vo2'] }

  return {
    ok: true,
    chrono,
    fitness: fa.age,
    // Negative is the good direction: fitness age below chronological age.
    delta: round1(fa.age - chrono),
    vo2: est.vo2,
    norm: normVo2(chrono, sex),
    sex,
    source: est.source,
    floor: !!est.floor,
    rough: !!est.rough,
    extrapolated: fa.extrapolated,
    clamped: fa.clamped,
    run: est.run || null,
    others: est.others || [],
  }
}
