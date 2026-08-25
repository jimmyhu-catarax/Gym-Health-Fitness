// Recovery and strain, computed rather than imported.
//
// whoop-metrics.js reads the scores Whoop already calculated. This module derives the same
// two quantities from their underlying physiology, which matters for three reasons: a band
// without an active subscription stops producing scores at all, an imported export goes stale
// the moment you train again, and Whoop scores a lifting session poorly because its model is
// cardiovascular. Where both exist the imported score wins — it saw beat-to-beat data this
// app never gets — and these are the fallback and the cross-check.
//
// Everything here is published, peer-reviewed method implemented from the formulas, not code
// lifted from another project. That distinction is deliberate: NOTICE.md is load-bearing in
// this repo and several open Whoop projects carry licences that would not survive contact
// with AGPL-3.0. Methods are not copyrightable; source is.
//
//   Banister TRIMP            Banister & Calvert 1980; sex coefficients from Morton, Fitz-Clarke
//                             & Banister 1990 — y=0.64/b=1.92 male, y=0.86/b=1.67 female
//   rMSSD, ln-transform       Task Force of the ESC/NASPE 1996, the HRV measurement standard
//   Rolling z-score recovery  the standard HRV-guided-training construct (Plews et al. 2013):
//                             today against your own 28-day baseline, not a population norm
//   erf                       Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
//
// The one thing to keep in mind reading the numbers: strain and recovery here are *this
// model's* strain and recovery. They track Whoop's because they rest on the same physiology,
// but the constants that map a TRIMP to a 0-21 scale are a fitted convention, not a law, and
// Whoop's exact mapping is proprietary. Two systems agreeing to a point is the honest claim.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round1 = n => Math.round(n * 10) / 10

/* ------------------------------------------------------------ statistics -- */

/**
 * Gauss error function — Abramowitz & Stegun 7.1.26.
 *
 * Here so the recovery score can go through a normal CDF without a stats dependency. The
 * approximation is accurate to ~1.5e-7, which is six digits more than a percentage needs.
 */
export function erf(x) {
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x)
  const p = 0.3275911
  const [a1, a2, a3, a4, a5] =
    [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]
  const t = 1 / (1 + p * x)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return sign * y
}

/** Standard normal CDF: the probability mass below z. */
export const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2))

export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

export function stdev(xs) {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length)
}

/* ----------------------------------------------------------------- HRV -- */

export const RR_MIN_MS = 300      // 200 bpm
export const RR_MAX_MS = 2000     // 30 bpm

/**
 * Drop ectopic beats and misdetections from an R-R series.
 *
 * Two filters, because they catch different faults: absolute bounds remove impossible
 * intervals, and the relative filter removes a beat that is physiologically possible on its
 * own but cannot follow the beat before it. A missed beat reads as one interval of roughly
 * double length — plausible in isolation, obvious in sequence — and it inflates rMSSD badly
 * enough to turn a bad night into a green recovery.
 */
export function cleanRr(rr, maxJump = 0.2) {
  const inBounds = (rr || []).filter(v => isFinite(v) && v >= RR_MIN_MS && v <= RR_MAX_MS)
  if (inBounds.length < 2) return []
  const out = [inBounds[0]]
  for (let i = 1; i < inBounds.length; i++) {
    const prev = inBounds[i - 1]
    if (Math.abs(inBounds[i] - prev) / prev <= maxJump) out.push(inBounds[i])
  }
  return out
}

/** Root mean square of successive differences, in ms — the standard vagal-tone index. */
export function rmssd(rr) {
  if (!rr || rr.length < 2) return null
  let sum = 0
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1]
    sum += d * d
  }
  return round1(Math.sqrt(sum / (rr.length - 1)))
}

/* --------------------------------------------------------------- strain -- */

/** Morton/Banister sex coefficients. Female hearts sit higher for the same relative load. */
export const TRIMP_COEF = { male: { y: 0.64, b: 1.92 }, female: { y: 0.86, b: 1.67 } }

/** Fraction of heart-rate reserve, clamped to [0,1] so a spurious spike cannot exceed max. */
export const hrReserve = (hr, rest, max) =>
  max > rest ? clamp((hr - rest) / (max - rest), 0, 1) : 0

/**
 * Banister TRIMP over a heart-rate series.
 *
 * The exponential term is the whole point: an hour easy and twenty minutes hard are not the
 * same load, and a linear time-in-zone model says they are.
 *
 * @param {number[]} hr    heart rate samples
 * @param {number} hz      sample rate; 1 Hz is what a strap exports
 */
export function banisterTrimp(hr, { rest, max, sex = 'male', hz = 1 } = {}) {
  if (!Array.isArray(hr) || !hr.length || !(max > rest) || !(hz > 0)) return null
  const { y, b } = TRIMP_COEF[sex] || TRIMP_COEF.male
  const dtMin = 1 / hz / 60
  let sum = 0
  for (const v of hr) {
    if (!isFinite(v)) continue
    const d = hrReserve(v, rest, max)
    sum += dtMin * d * y * Math.exp(b * d)
  }
  return round1(sum)
}

/**
 * TRIMP from an average heart rate and a duration.
 *
 * The coarse path, and the only one available for an imported session: Whoop's workouts.csv
 * gives average and max HR, never the series. Jensen's inequality says this *understates* a
 * variable session — the exponential of a mean is below the mean of exponentials — so an
 * interval workout scores lower here than it should. Callers label it; it is not silently
 * mixed with a real series-derived value.
 */
export function trimpFromAverage(avgHr, minutes, { rest, max, sex = 'male' } = {}) {
  if (!isFinite(avgHr) || !isFinite(minutes) || minutes <= 0 || !(max > rest)) return null
  const { y, b } = TRIMP_COEF[sex] || TRIMP_COEF.male
  const d = hrReserve(avgHr, rest, max)
  return round1(minutes * d * y * Math.exp(b * d))
}

/** Where an exhaustive endurance session lands. Tunable, and a convention rather than a law. */
export const STRAIN_TAU = 85

/**
 * Map an unbounded TRIMP onto Whoop's familiar 0-21 scale.
 *
 * Saturating rather than linear, so the difference between a hard day and a brutal one stays
 * visible at the top of the range instead of everything above "hard" pinning at 21.
 */
export function trimpToStrain(trimp, tau = STRAIN_TAU) {
  if (!isFinite(trimp) || trimp < 0) return null
  return round1(21 * (1 - Math.exp(-trimp / tau)))
}

/* ------------------------------------------------------------- recovery -- */

export const RECOVERY_WINDOW = 28
export const RECOVERY_MIN_DAYS = 7
export const Z_SCALE = 1.5
export const W_HRV = 0.7
export const W_RHR = 0.3

/** Whoop's three-colour convention, reproduced so the UI reads the way people expect. */
export const recoveryZone = pct => (pct >= 67 ? 'green' : pct >= 34 ? 'yellow' : 'red')

/**
 * Recovery as a percentile against your own recent baseline.
 *
 * Deliberately relative, not absolute: an HRV of 40 ms is unremarkable for one person and
 * alarming for another, so a population norm would tell most people very little. What carries
 * signal is today against your own last four weeks.
 *
 * ln(rMSSD) rather than rMSSD because the raw distribution is strongly right-skewed, and a
 * z-score of a skewed variable puts the mean in the wrong place — the log transform is
 * standard practice in the HRV-guided-training literature for exactly that reason.
 *
 * Returns null rather than a number when the baseline is too short. Seven days is already
 * thin, and a z-score against three points is arithmetic pretending to be information.
 */
export function recoveryScore({ hrv, rhr, hrvBase = [], rhrBase = [], scale = Z_SCALE } = {}) {
  const lnHrv = isFinite(hrv) && hrv > 0 ? Math.log(hrv) : null
  const lnBase = hrvBase.filter(v => isFinite(v) && v > 0).map(Math.log)
  const rBase = rhrBase.filter(isFinite)

  const parts = []
  let z = 0, weight = 0
  if (lnHrv != null && lnBase.length >= RECOVERY_MIN_DAYS) {
    const sd = stdev(lnBase)
    if (isFinite(sd) && sd > 1e-4) {
      const zh = (lnHrv - mean(lnBase)) / sd
      z += W_HRV * zh; weight += W_HRV
      parts.push({ k: 'hrv', z: round1(zh) })
    }
  }
  if (isFinite(rhr) && rBase.length >= RECOVERY_MIN_DAYS) {
    const sd = stdev(rBase)
    if (isFinite(sd) && sd > 1e-4) {
      // Negated: a resting heart rate above your baseline is a cost, not a credit.
      const zr = (rhr - mean(rBase)) / sd
      z -= W_RHR * zr; weight += W_RHR
      parts.push({ k: 'rhr', z: round1(zr) })
    }
  }
  if (!weight) return null

  // Renormalise when only one input was usable, so a profile with HRV but no resting heart
  // rate is not permanently pushed toward 50% by a missing term.
  const zNet = z / weight
  const pct = clamp(Math.round(normCdf(zNet / scale) * 100), 1, 99)
  return { pct, zone: recoveryZone(pct), z: round1(zNet), parts, inputs: parts.map(p => p.k) }
}

/**
 * Recovery for one day of the profile's own metrics series.
 *
 * The baseline is the `window` days *before* the target, never including it — a day that
 * contributes to its own baseline is compared against itself and drifts toward the middle.
 *
 * @param {Array<{d:string,hrv?:number,rhr?:number}>} metrics  sorted ascending by date
 */
export function recoveryFor(metrics, date, { window = RECOVERY_WINDOW } = {}) {
  if (!Array.isArray(metrics) || !metrics.length) return null
  const i = metrics.findIndex(m => m.d === date)
  if (i < 0) return null
  const today = metrics[i]
  const prior = metrics.slice(Math.max(0, i - window), i)
  return recoveryScore({
    hrv: today.hrv,
    rhr: today.rhr,
    hrvBase: prior.map(m => m.hrv).filter(v => v != null),
    rhrBase: prior.map(m => m.rhr).filter(v => v != null),
  })
}

/**
 * Fill in a computed recovery for every day the import did not supply one.
 *
 * An imported score always wins: Whoop saw beat-to-beat data and a body-temperature channel
 * this app never receives. The computed value is there for the days after your last export,
 * and for a band whose subscription has lapsed. `recoverySrc` records which is which so the
 * UI can say so rather than presenting two different quantities as one series.
 */
export function withComputedRecovery(metrics, opts = {}) {
  if (!Array.isArray(metrics)) return []
  return metrics.map((m, i) => {
    if (m.recovery != null) return { ...m, recoverySrc: 'whoop' }
    const r = recoveryFor(metrics, m.d, opts)
    return r ? { ...m, recovery: r.pct, recoverySrc: 'computed', recoveryZ: r.z } : { ...m }
  })
}
