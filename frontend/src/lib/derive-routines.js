// Rebuild routines from an imported training history.
//
// Every app import-csv.js reads exports what you *did*, never what you *planned*. So a
// history imported from Hevy or Strong arrives complete and half-useless: years of
// sessions, no routine behind any of them, and a progression engine (progression.js)
// that needs a routine before it can prescribe a single next set. Until now the first
// thing a migrating user had to do was hand-rebuild every split they already owned,
// from the history sitting right there in front of them.
//
// This reads the routines back out of the sessions. Hevy and Strong write the workout's
// title on every row, so the grouping is already in the file — what is missing is only
// the template, and the template is what those sessions have in common.
//
// It infers, so it takes the importers' stance: a group that does not resolve is
// REFUSED, NOT GUESSED AT. A wrong routine is not as costly as a wrong weight, but a
// plausible-looking one nobody actually trains is worse than no routine at all, because
// it is the thing the progression engine will then prescribe from. Three guards do the
// refusing — see MIN_SESSIONS, MIN_SHARE and MIN_COHESION below — and every group they
// throw out is reported so the import sheet can say what was left behind rather than
// letting it vanish.
//
// Nothing here writes: it returns routines and a workout -> routine mapping, and the
// import summary shows both before the user confirms.

import { uid } from './format.js'
import { DEFAULT_GLYPH } from './glyphs.js'

// A title seen fewer than this many times is one session, not a routine.
export const MIN_SESSIONS = 3
// An exercise has to turn up in this share of the group's sessions to be part of the
// template. Half is deliberately lax: people skip lifts, and a routine that drops
// everything you have ever missed is not the routine you train.
export const MIN_SHARE = 0.5
// ...but the exercises that survive MIN_SHARE must still make up this much of a typical
// session under that title, or the title is a label rather than a plan. This is the
// guard that catches a catch-all: if you log push, pull and legs all as "Gym", no
// exercise clears half the sessions and what does clear it covers almost nothing.
export const MIN_COHESION = 0.5
// A template of one lift is not a template.
const MIN_EXERCISES = 2
const MAX_EXERCISES = 15
const MAX_ROUTINES = 12

/** Median of some numbers. Robust where a mean is not: one 20-set session is a marathon,
 *  not evidence that the routine calls for 20 sets. */
export function median(xs) {
  const a = xs.filter(x => Number.isFinite(x)).sort((p, q) => p - q)
  if (!a.length) return 0
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Titles that name an occasion rather than a plan.
//
// Hevy titles an unnamed workout by the time of day — "Morning Workout", "Evening
// Workout" — so a user who never named anything has one giant pseudo-routine per part of
// the day, mixing every split they train. MIN_COHESION would usually refuse those
// anyway; this refuses them by name too, because the failure is known and specific and a
// user who genuinely calls their split "Morning Workout" loses nothing but a shortcut.
const GENERIC = /^(imported|workout|untitled|session|training|gym|exercise)$/
const TIME_OF_DAY = /^(early |late )?(morning|afternoon|evening|night|noon|midday|lunch|midnight|am|pm)( workout| session| training)?$/
const DATE_LIKE = /^[\d\s\-/.:]+$/

export const isGenericName = name => {
  const n = normName(name)
  return !n || GENERIC.test(n) || TIME_OF_DAY.test(n) || DATE_LIKE.test(n)
}

// Glyph from the title, so a rebuilt plan does not arrive as twelve identical icons.
// Order matters: "Push/Pull" hits push first, which is as good a guess as any.
const GLYPH_BY_NAME = [
  [/\b(leg|squat|quad|glute|hamstring|calf|calves|lower)\b/, 'legs'],
  [/\b(pull|back|lat|row|deadlift|chin)\b/, 'pullup'],
  [/\b(push|chest|bench|press|shoulder|delt)\b/, 'figureStrength'],
  [/\b(arm|bicep|tricep|curl)\b/, 'arm'],
  [/\b(ab|abs|core|oblique)\b/, 'abs'],
  [/\b(run|jog|treadmill|cardio|5k|10k)\b/, 'figureRun'],
  [/\b(bike|cycle|cycling|spin|spinning)\b/, 'bike'],
  [/\b(swim|pool)\b/, 'swim'],
  [/\b(box|boxing|bag|mma)\b/, 'boxing'],
  [/\b(stretch|mobility|yoga|recovery)\b/, 'stretch'],
  [/\b(kettlebell|kb)\b/, 'kettlebell'],
  [/\b(dumbbell|db)\b/, 'dumbbell'],
  [/\b(machine|cable)\b/, 'machine'],
]

export function glyphFor(name) {
  const n = normName(name)
  for (const [re, g] of GLYPH_BY_NAME) if (re.test(n)) return g
  return DEFAULT_GLYPH
}

// Sets the template asks for. Warm-ups are marked by the file (import-csv.js reads
// Hevy's and Strong's set_type) and excluded: "4 sets of bench" means four working
// sets, and counting the two ramp-up sets with them prescribes six.
const workingSets = entry => {
  const work = entry.sets.filter(s => !s.wu)
  return work.length || entry.sets.length
}

/**
 * Derive routines from a list of imported workouts.
 *
 * @param {Array} workouts  as built by parseWorkoutCSV — { id, d, name, entries:[{id,sets}] }
 * @returns {{routines: Array, links: Object, skipped: Array}}
 *   routines  ready for S.routines, each carrying `sessions` (how many it was built from)
 *   links     workout id -> routine id, for the caller to apply
 *   skipped   [{ name, sessions, why }] with why in 'generic' | 'few' | 'varied'
 */
export function deriveRoutines(workouts, opts = {}) {
  const minSessions = opts.minSessions ?? MIN_SESSIONS
  const minShare = opts.minShare ?? MIN_SHARE
  const minCohesion = opts.minCohesion ?? MIN_COHESION

  const groups = new Map()
  for (const w of workouts || []) {
    if (!w || !Array.isArray(w.entries) || !w.entries.length) continue
    const key = normName(w.name)
    let g = groups.get(key)
    if (!g) { g = { key, names: new Map(), sessions: [] }; groups.set(key, g) }
    const label = String(w.name || '').trim()
    if (label) g.names.set(label, (g.names.get(label) || 0) + 1)
    g.sessions.push(w)
  }

  const routines = [], links = {}, skipped = []

  for (const g of groups.values()) {
    // The commonest exact spelling in the group — normName collapsed case and
    // punctuation to group them, but the routine should read the way the user wrote it.
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || ''
    const n = g.sessions.length

    if (isGenericName(name)) { skipped.push({ name: name || '(untitled)', sessions: n, why: 'generic' }); continue }
    if (n < minSessions) { skipped.push({ name, sessions: n, why: 'few' }); continue }

    // How often each exercise turns up, and where in the session it sits.
    const seen = new Map()
    for (const w of g.sessions) {
      const once = new Set()
      w.entries.forEach((e, i) => {
        if (once.has(e.id)) return
        once.add(e.id)
        let s = seen.get(e.id)
        if (!s) { s = { id: e.id, days: 0, order: [], sets: [], reps: [] }; seen.set(e.id, s) }
        s.days++
        s.order.push(i)
      })
      for (const e of w.entries) {
        const s = seen.get(e.id)
        s.sets.push(workingSets(e))
        for (const set of e.sets) if (set.r > 0) s.reps.push(set.r)
      }
    }

    const kept = [...seen.values()]
      .filter(s => s.days / n >= minShare)
      .sort((a, b) => b.days - a.days || median(a.order) - median(b.order))
      .slice(0, MAX_EXERCISES)
      .sort((a, b) => median(a.order) - median(b.order))

    if (kept.length < MIN_EXERCISES) { skipped.push({ name, sessions: n, why: 'varied' }); continue }

    // Do those exercises actually make up the session, or are they the only fixed points
    // in something that changes every week?
    const keptIds = new Set(kept.map(s => s.id))
    const cohesion = median(g.sessions.map(w => {
      const ids = new Set(w.entries.map(e => e.id))
      if (!ids.size) return 0
      return [...ids].filter(id => keptIds.has(id)).length / ids.size
    }))
    if (cohesion < minCohesion) { skipped.push({ name, sessions: n, why: 'varied' }); continue }

    const id = uid()
    routines.push({
      id, name, emoji: glyphFor(name),
      // weight stays 0: mergeImport seeds S.exWeights from the newest imported set of
      // each lift, so the app already knows what you last put on the bar. Copying a
      // median weight in here would freeze a number that history answers better.
      ex: kept.map(s => ({
        id: s.id,
        sets: Math.max(1, Math.round(median(s.sets))),
        reps: Math.round(median(s.reps)),
        weight: 0,
      })),
      sessions: n,
    })
    for (const w of g.sessions) links[w.id] = id
  }

  // Most-trained first, so a plan rebuilt from five years of history opens on the split
  // the user actually lives in.
  routines.sort((a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : 1))
  const cut = routines.slice(MAX_ROUTINES)
  for (const r of cut) {
    skipped.push({ name: r.name, sessions: r.sessions, why: 'many' })
    for (const k of Object.keys(links)) if (links[k] === r.id) delete links[k]
  }
  skipped.sort((a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : 1))
  return { routines: routines.slice(0, MAX_ROUTINES), links, skipped }
}
