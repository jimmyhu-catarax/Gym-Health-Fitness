// The example profile behind the demo build (see demo.js). Imported dynamically, so it stays
// out of the bundle self-hosters ship.
import { isoOf, uid } from './format.js'
import { starterRoutines } from './starter.js'
import { modeOf } from './history.js'

// Starting weight and weekly increment per exercise of the starter plan (kg).
// Chest dips are body-weight only here, so they log reps at 0 added weight.
const PROG = {
  '0025': [60, 1.25], '0047': [45, 1], '0426': [20, 0.5], '0334': [10, 0.25], '0241': [25, 0.75], '0251': [0, 0],
  '2330': [50, 1.25], '0027': [50, 1], '1323': [45, 1], '0031': [30, 0.5], '0313': [12, 0.3],
  '0043': [70, 1.5], '0085': [60, 1.25], '0739': [120, 3], '0585': [45, 1], '0586': [40, 1], '0605': [60, 1.5]
}
const WEEKS = 12                       // how much history to fabricate
const BW_FROM = 82.4, BW_TO = 78.3     // body-weight trend across those weeks
const TARGET_W = 77

// --- Effort -----------------------------------------------------------------------------
// The demo has to show the effort stats, not just the volume ones, so the history carries
// ratings. Flat ratings would draw a flat trend and prove nothing, so this fabricates the
// shape the charts exist to make visible: a block grinding toward failure, a deload jumping
// back off it, another block going a little deeper than the first.
const DELOAD_WEEK = 5
// Reps left in the tank the block is aiming for, by week.
const weekTarget = wk =>
  wk === DELOAD_WEEK ? 4.5
    : wk < DELOAD_WEEK ? 2.8 - wk * 0.3
      : 2.6 - (wk - DELOAD_WEEK - 1) * 0.26
// Leg day is trained further from failure than the upper body — deliberate, so the muscle
// map's "hard sets" mode shows a different picture from its all-sets mode.
const EASY = new Set(['0043', '0085', '0739', '0585', '0586'])
// One exercise nobody ever rates: partial coverage is the normal case (rating is optional and
// off by default), and it shows the per-exercise Effort toggle correctly staying away.
const NEVER_RATED = '0605'
const UNRATED = 0.1                    // …plus this share of the remaining sets, at random
// The first weeks are logged in RPE, as if they came out of another app before the profile
// switched to RIR. A set is never rewritten (see history.js), so the stats have to average a
// mixed history as one series — the demo should be showing that, not hiding it.
const RPE_UNTIL = 3
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Deterministic PRNG — the demo should look the same on every visit and in screenshots.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const round = (w, step) => Math.round(w / step) * step
const at = (date, h, m) => { const d = new Date(date); d.setHours(h, m, 0, 0); return d.getTime() }
// The Monday of a date. The effort trend is plotted per calendar week, so the training block
// has to run on calendar weeks too — a deload counted off the first day of the history would
// straddle two points and average itself away in both.
const monday = date => { const d = new Date(date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(12, 0, 0, 0); return +d }

// A full example profile: 12 weeks of Mon/Wed/Fri sessions on the starter plan, with linear
// progression, the odd missed session, twice-weekly weigh-ins trending toward the goal, and
// per-set effort ratings on most (not all) of it.
export function buildDemoState() {
  const rnd = rng(20260723)
  const [push, pull, legs] = starterRoutines()
  const byWeekday = { 1: push, 3: pull, 5: legs }

  const nowH = new Date().getHours()
  const today = new Date(); today.setHours(12, 0, 0, 0)
  const start = new Date(today); start.setDate(start.getDate() - WEEKS * 7)

  const workouts = []
  const bodyweight = []
  const exWeights = {}
  const best = {}

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const day = new Date(d)
    const iso = isoOf(day)
    const weekIdx = Math.floor((day - start) / (7 * 86400000))
    const p = Math.min(1, weekIdx / WEEKS)

    // weigh-ins: Monday and Thursday mornings
    if (day.getDay() === 1 || day.getDay() === 4) {
      const w = BW_FROM + (BW_TO - BW_FROM) * p + (rnd() - 0.5) * 0.7
      bodyweight.push({ d: iso, w: Math.round(w * 10) / 10, t: at(day, 7, 30) })
    }

    const routine = byWeekday[day.getDay()]
    if (!routine) continue
    if (rnd() < 0.09) continue                      // life happens — a few missed sessions
    if (iso === isoOf(today) && nowH < 18) continue   // leave today's session to try out, unless it's already evening

    const prs = []
    const blockWk = Math.round((monday(day) - monday(start)) / (7 * 86400000))
    const rir0 = weekTarget(blockWk)
    const scale = blockWk < RPE_UNTIL ? 'rpe' : 'rir'
    const entries = routine.ex.map((cfg, exIdx) => {
      const [base, inc] = PROG[cfg.id] || [20, 0.5]
      const step = base >= 40 ? 2.5 : 1.25
      // The deload pulls the weight back too — effort dropping on its own would look like the
      // same session suddenly got easy.
      const back = blockWk === DELOAD_WEEK ? 0.88 : 1
      const w = base ? Math.max(step, round((base + inc * weekIdx) * back, step)) : 0
      const rateable = modeOf(cfg) === 'reps' && cfg.id !== NEVER_RATED
      const sets = []
      for (let i = 0; i < cfg.sets; i++) {
        // last set is where reps usually start slipping
        const drop = i === cfg.sets - 1 && rnd() < 0.55 ? (rnd() < 0.4 ? 2 : 1) : 0
        const s = { w, r: Math.max(4, cfg.reps - drop), done: true }
        const rir = clamp(round(rir0
          + (cfg.sets - 1 - i) * 0.6      // a first set sits further from failure than a last
          - exIdx * 0.12                  // …and fatigue accumulates across the session
          + (EASY.has(cfg.id) ? 1.2 : 0)
          - (drop ? 0.5 : 0)              // reps slipping is the set that ran out of room
          + (rnd() - 0.5), 0.5), 0, 6)
        if (rateable && rnd() > UNRATED) {
          // RPE's floor of 6 is a convention about which sets are worth rating, so an easy
          // set logged in RPE genuinely loses the distance it was from failure.
          if (scale === 'rpe') s.rpe = clamp(10 - rir, 6, 10)
          else s.rir = rir
        }
        sets.push(s)
      }
      if (w > (best[cfg.id] || 0)) { best[cfg.id] = w; prs.push(cfg.id) }
      exWeights[cfg.id] = { w: Math.max(w, exWeights[cfg.id]?.w || 0), d: iso }
      return { id: cfg.id, sets, topW: w || null }
    })

    const bw = bodyweight.length ? bodyweight[bodyweight.length - 1].w : BW_FROM
    const startMs = at(day, 18, 5 + Math.floor(rnd() * 25))
    const w = {
      id: uid(), d: iso, start: startMs, end: startMs + (46 + Math.floor(rnd() * 26)) * 60000,
      routineId: routine.id, name: routine.name, bw,
      entries,
      prs: weekIdx === 0 ? [] : prs   // the very first session isn't a PR party
    }
    w.vol = entries.reduce((v, e) => v + e.sets.reduce((n, s) => n + s.w * s.r, 0), 0)
    workouts.push(w)
  }

  // A visitor should always have something to press "Start" on, so if they land on a rest day
  // the next routine in the rotation is moved onto today — which also shows off rescheduling.
  const dayPlan = {}
  const tIso = isoOf(today)
  if (!byWeekday[today.getDay()] && !workouts.some(w => w.d === tIso)) {
    const order = [push, pull, legs]
    const lastName = workouts.length ? workouts[workouts.length - 1].name : legs.name
    dayPlan[tIso] = order[(order.findIndex(r => r.name === lastName) + 1) % order.length].id
  }

  // Physiology, correlated with the training above rather than sprinkled on top.
  //
  // Without this the demo shows the Whoop half in its empty state, which makes the whole
  // recovery feature invisible to anybody trying the app — and the Training & recovery card
  // exists precisely to show a relationship, so seeding independent noise would demonstrate
  // the opposite of the point. So recovery dips the morning after a session, strain rises on
  // days that had one, and sleep runs a little shorter after the heavier days.
  //
  // It is fabricated, and the demo profile is the one place in this app where that is the
  // honest thing to do: everything here is invented history, clearly labelled as a demo, and
  // an example that shows nothing teaches nothing.
  const trainedOn = new Set(workouts.map(w => w.d))
  const metrics = []
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const day = new Date(d)
    const iso = isoOf(day)
    const prev = new Date(day); prev.setDate(prev.getDate() - 1)
    const afterTraining = trainedOn.has(isoOf(prev))
    const wave = Math.sin((day - start) / (86400000 * 9)) * 0.5 + (rnd() - 0.5) * 0.6

    const recovery = Math.max(12, Math.min(97, Math.round(
      68 + wave * 14 - (afterTraining ? 11 : 0))))
    const hrv = Math.round((48 + wave * 9 - (afterTraining ? 5 : 0)) * 10) / 10
    const rhr = Math.round(52 - wave * 3 + (afterTraining ? 2 : 0))
    const strain = Math.round((trainedOn.has(iso) ? 13.5 + wave * 3 : 6.5 + wave * 2) * 10) / 10
    const light = Math.round(214 + wave * 20 - (afterTraining ? 6 : 0))
    const deep = Math.round(97 + wave * 14)
    const rem = Math.round(110 + wave * 16)
    metrics.push({
      d: iso, t: at(day, 7, 15), src: 'Whoop',
      recovery, hrv, rhr, strain,
      sleepDur: light + deep + rem, light, deep, rem,
      awake: Math.round(36 - wave * 6), sleepNeed: 486,
      sleepPerf: Math.max(40, Math.min(100, Math.round(87 + wave * 9))),
      sleepEff: Math.max(50, Math.min(100, Math.round(91 + wave * 4))),
    })
  }

  return {
    routines: [push, pull, legs],
    week: { 1: push.id, 3: pull.id, 5: legs.id },
    dayPlan,
    workouts, bodyweight, exWeights,
    targetW: TARGET_W,
    // The history is rated, so the demo turns the column on and the stats get a scale to
    // label their aggregates with instead of guessing one (see displayScale).
    effort: 'rir',
    // Fitness age inputs, so the demo shows the card computing rather than asking to be set
    // up. Birth is relative to today for the same reason every other date here is: the demo
    // person should still be 34 in five years, not 39.
    birth: new Date(today.getFullYear() - 34, 2, 14).toISOString().slice(0, 10),
    physSex: 'male',
    // No run in this history, so the card falls back to the resting-heart-rate route — which
    // also puts its "roughest of the three" caveat on screen, where it belongs.
    restHr: 56,
    metrics
  }
}
