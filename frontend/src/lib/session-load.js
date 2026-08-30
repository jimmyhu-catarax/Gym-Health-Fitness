// What a lifting session costs.
//
// physiology.js turns heart rate into strain, which is the right model for the sessions
// Whoop recorded and useless for the ones it did not. A barbell session is intermittent by
// design — thirty seconds of work, three minutes of rest — so average heart rate
// understates it badly, and a lifter's whole week can land in the strain series as a flat
// line with a couple of cardio spikes on it. The load half of the app then describes
// somebody else's training.
//
// So lifting gets its own load number, on one of two bases, and the app says which one it
// used. Neither is interchangeable with a Whoop strain and nothing here adds them together.
//
//   **sRPE** (Foster et al. 2001, "A new approach to monitoring exercise training",
//   J Strength Cond Res 15(1):109-115) — session RPE x minutes, in arbitrary units. The
//   standard method for resistance training, and the better of the two: it counts a heavy
//   triple and a set of bodyweight dips as the work they were. It needs the effort column,
//   which this app leaves off by default, so it is only available to profiles that log RIR
//   or RPE — or to an import from Hevy or Strong, which both record it.
//
//   **Volume load** — the sum of weight x reps, which every profile has. It is a real
//   measure and the one most lifting apps show, but it is blind in two directions: a
//   bodyweight session scores zero, and squats outscore presses for reasons that have
//   nothing to do with effort.
//
// The basis is chosen once for the whole series, from coverage over the recent window, and
// never mixed within it: a ratio of a series against itself only means anything while the
// series measures one thing. dailyLoad() reports which basis it picked so the screen can
// name it, because "training load 1.4x" reads very differently depending on the answer.

import { workoutVolume } from './history.js'

/** Foster's CR-10 scale. RIR is the same scale read from the other end. */
export const RPE_MAX = 10
const clampRpe = x => Math.min(RPE_MAX, Math.max(0, x))

// A session shorter than this is a mis-logged row; longer, a timer somebody left running.
// Both would otherwise dominate an sRPE series, which is linear in duration.
export const MIN_MINUTES = 5
export const MAX_MINUTES = 360
// Below this share of rated sets the mean is not the session's effort, it is one set's.
export const MIN_RATED_SHARE = 0.5
// Below this share of sessions carrying an sRPE, the series falls back to volume rather
// than reporting a month built from the seven days somebody happened to rate.
export const MIN_SRPE_COVERAGE = 0.6

/** One set's effort on the RPE scale, or null. RIR wins where a set carries both — the
 *  same precedence setLabel reads them back with. */
export function setRpe(s) {
  if (!s) return null
  if (s.rir != null && Number.isFinite(s.rir)) return clampRpe(RPE_MAX - s.rir)
  if (s.rpe != null && Number.isFinite(s.rpe)) return clampRpe(s.rpe)
  return null
}

/**
 * The session's effort: the mean over its completed sets.
 *
 * Null unless at least half of them were rated. A single RPE on set 3 of 30 is a set's
 * effort, not a session's, and Foster's number is only as good as the rating behind it.
 */
export function sessionRpe(w, { minShare = MIN_RATED_SHARE } = {}) {
  if (!w || !Array.isArray(w.entries)) return null
  const done = []
  for (const e of w.entries) for (const s of (e.sets || [])) if (s && s.done) done.push(s)
  if (!done.length) return null
  const rated = done.map(setRpe).filter(v => v != null)
  if (!rated.length || rated.length / done.length < minShare) return null
  return Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10
}

/** Session length in minutes, or null when the file did not record one worth trusting. */
export function sessionMinutes(w) {
  if (!w) return null
  const min = (Number(w.end) - Number(w.start)) / 60000
  if (!Number.isFinite(min) || min < MIN_MINUTES || min > MAX_MINUTES) return null
  return Math.round(min)
}

/** Foster's session load in arbitrary units, or null when either half is missing. */
export function sessionLoad(w, opts) {
  const rpe = sessionRpe(w, opts)
  const min = sessionMinutes(w)
  if (rpe == null || min == null) return null
  return Math.round(rpe * min)
}

const DAY = 86400000
const dayMs = d => Date.parse(String(d) + 'T12:00:00Z')

/**
 * A daily lifting-load series, on whichever basis the history can actually support.
 *
 * The window only chooses the basis. The series itself runs over every workout given, so a
 * 28-day baseline can reach back past it — but on the chosen basis alone, so a profile that
 * switched the effort column on last week gets a volume series rather than an sRPE one with
 * three weeks missing from underneath it.
 *
 * @returns {{basis: 'srpe'|'volume'|null, unit: string, days: Array<{d: string, load: number}>, rated: number, sessions: number}}
 */
export function dailyLoad(workouts, { now = Date.now(), window = 28 } = {}) {
  const list = (workouts || []).filter(w => w && w.d && Array.isArray(w.entries) && w.entries.length)
  // Same window convention as trends.js: n days means today and the n-1 before it.
  const since = now - (window - 1) * DAY
  const recent = list.filter(w => dayMs(w.d) >= since && dayMs(w.d) <= now)
  const rated = recent.filter(w => sessionLoad(w) != null).length
  const basis = recent.length && rated / recent.length >= MIN_SRPE_COVERAGE ? 'srpe' : 'volume'

  const by = new Map()
  for (const w of list) {
    const load = basis === 'srpe' ? sessionLoad(w) : workoutVolume(w)
    // A zero-volume day is a bodyweight session the volume basis cannot see, not a rest
    // day. Leaving it out keeps it from being averaged in as a day of no training.
    if (load == null || !(load > 0)) continue
    by.set(w.d, (by.get(w.d) || 0) + load)
  }
  return {
    basis: by.size ? basis : null,
    unit: basis === 'srpe' ? 'AU' : 'volume',
    days: [...by.entries()].map(([d, load]) => ({ d, load: Math.round(load) }))
      .sort((a, b) => (a.d < b.d ? -1 : 1)),
    rated, sessions: recent.length,
  }
}
