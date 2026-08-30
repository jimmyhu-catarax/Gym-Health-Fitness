// Hevy's actual routines, turned into this app's.
//
// `derive-routines.js` reconstructs plans from what was trained, because a CSV export is all
// there was. It is a good reconstruction and it stays — it is the only option for a Strong or
// FitNotes file, and for anyone without a Hevy Pro key. But it is inference, and it has two
// limits nothing in the history can lift:
//
//   - **It cannot see a routine you have not trained yet.** `MIN_SESSIONS` is 3, so the split
//     you wrote last night is invisible until you have run it three times. That is exactly
//     the routine you most want on today's screen.
//   - **It cannot recover intent.** A median over sessions says what you did, and rounds away
//     the difference between a plan of 5×5 and five sessions that happened to average five.
//
// So where a key is available the real routine wins, and the derivation becomes the fallback
// it should always have been. Both paths produce the same shape and go through the same
// confirm sheet, so nothing downstream needs to know which one ran.
//
// The join is **by name**, and deliberately so. Hevy's routine ids never reach here — the sync
// bridges through Hevy's own CSV export, which has no id column — so a real routine adopts the
// id of the derived one with the same name, and every session the derivation linked stays
// linked. A real routine with no derived twin is simply new: nothing has trained it.

import { matchExercise } from './import-csv.js'
import { glyphFor, normName } from './derive-routines.js'
import { uid } from './format.js'

/** Hevy set types that are not part of the prescription. */
const WARMUP = /warm/i

/** Sets a routine asks for, at most. A 40-set entry is a bad read, not a workout. */
export const MAX_SETS = 40
/** Reps a routine asks for, at most. */
export const MAX_REPS = 500

const num = (v, lo, hi) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && isFinite(n) && n >= lo && n <= hi ? n : null
}

const pick = (o, names) => {
  if (!o || typeof o !== 'object') return undefined
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n]
  return undefined
}

const listOf = (o, names) => {
  const v = pick(o, names)
  return Array.isArray(v) ? v : []
}

/**
 * The reps a set asks for.
 *
 * Hevy Pro routines can carry a `rep_range` instead of a fixed count. The app's routine holds
 * one number, so the range has to collapse to one, and it collapses to the **low end**: that
 * is the rep count you have committed to hitting, and a prescription you fall short of every
 * session is worse than one you clear. The range is not lost — `reps` is only ever a starting
 * point here, and the progression engine moves it from the sets you actually log.
 */
export function repsOf(set) {
  const flat = num(pick(set, ['reps', 'rep_count']), 1, MAX_REPS)
  if (flat !== null) return Math.round(flat)
  const range = pick(set, ['rep_range', 'repRange'])
  if (range && typeof range === 'object') {
    const lo = num(pick(range, ['start', 'min', 'low', 'from']), 1, MAX_REPS)
    const hi = num(pick(range, ['end', 'max', 'high', 'to']), 1, MAX_REPS)
    if (lo !== null) return Math.round(lo)
    if (hi !== null) return Math.round(hi)
  }
  return null
}

/**
 * One Hevy routine -> one of this app's, or null when there is nothing usable in it.
 *
 * @param {object} r        a routine from `GET /v1/routines`
 * @param {object} [opts]
 * @param {Function} [opts.match]  name -> exercise id, for tests
 * @returns {{routine:object, unmatched:string[], created:object[]}|null}
 */
export function mapRoutine(r, { match = matchExercise } = {}) {
  const name = String(pick(r, ['title', 'name']) || '').trim()
  if (!name) return null

  const raw = listOf(r, ['exercises', 'exercise'])
  // Hevy documents an `index` per exercise. Sort by it rather than trusting array order:
  // the order is the routine, and an entry arriving out of order silently reorders a session.
  const ordered = [...raw].map((e, i) => ({ e, i, ix: num(pick(e, ['index']), 0, 1e4) ?? i }))
    .sort((a, b) => a.ix - b.ix || a.i - b.i)

  const ex = [], unmatched = [], created = []
  for (const { e } of ordered) {
    const title = String(pick(e, ['title', 'name']) || '').trim()
    if (!title) continue

    const sets = listOf(e, ['sets', 'set'])
    // Warm-ups are ramp-up, not prescription. Counting them turns 3 working sets into 5.
    const working = sets.filter(s => !WARMUP.test(String(pick(s, ['type', 'set_type']) || '')))
    // A routine entry with no sets at all is still a real entry — Hevy lets you add an
    // exercise before deciding the volume — so it prescribes one set rather than vanishing.
    const nSets = Math.min(MAX_SETS, Math.max(1, working.length || 1))

    const repList = working.map(repsOf).filter(n => n !== null)
    // The modal rep count, not the mean: a 5/5/5/AMRAP finisher should read as 5.
    const reps = repList.length ? mode(repList) : null

    let id = match(title)
    if (!id) {
      id = 'hv' + uid()
      created.push({ id, n: title.toLowerCase(), custom: true, eq: 'custom', tg: '', desc: '', bp: 'upper legs' })
      unmatched.push(title)
    }
    // weight stays 0 for the same reason derive-routines leaves it 0: mergeImport seeds
    // exWeights from the newest set actually logged, so the app already knows what was last
    // on the bar. A routine's target weight is often months stale; the log never is.
    ex.push({ id, sets: nSets, reps: reps ?? 8, weight: 0 })
  }

  if (!ex.length) return null
  return { routine: { id: uid(), name, emoji: glyphFor(name), ex, real: true }, unmatched, created }
}

/** Most common value, ties going to the largest — a 5/5/8 reads as 5, a 5/8 as 8. */
function mode(list) {
  const c = new Map()
  for (const v of list) c.set(v, (c.get(v) || 0) + 1)
  let best = null, n = -1
  for (const [v, k] of c) if (k > n || (k === n && v > best)) { best = v; n = k }
  return best
}

/**
 * Every Hevy routine, in this app's shape.
 *
 * @returns {{routines:Array, customEx:Array, unmatchedNames:string[], skipped:number}}
 */
export function mapRoutines(raw, opts = {}) {
  const routines = [], customEx = [], unmatched = new Set()
  let skipped = 0
  const seen = new Set()
  for (const r of Array.isArray(raw) ? raw : []) {
    const m = mapRoutine(r, opts)
    if (!m) { skipped++; continue }
    // Hevy allows two routines with the same name. Keeping both would make the name-join
    // below ambiguous and show the user a duplicate, so the first wins.
    const k = normName(m.routine.name)
    if (seen.has(k)) { skipped++; continue }
    seen.add(k)
    routines.push(m.routine)
    customEx.push(...m.created)
    m.unmatched.forEach(n => unmatched.add(n))
  }
  return { routines, customEx, unmatchedNames: [...unmatched].sort(), skipped }
}

/**
 * Overlay real routines onto a parsed import whose routines were derived from its history.
 *
 * A real routine that shares a derived one's name **takes over that routine's id**, so every
 * session the derivation linked stays linked while the contents become the ones Hevy actually
 * holds. A real routine with no derived twin is added as new and has no sessions, which is
 * the honest state: it is a plan, and nothing has trained it yet.
 *
 * A derived routine with no real twin survives. Hevy's routine list is what is in the app
 * today, and a split trained for two years and since deleted there is still the best
 * explanation of those two years of sessions.
 *
 * Returns a new parsed object; the input is not mutated.
 */
export function applyRealRoutines(parsed, real) {
  const list = (real && real.routines) || []
  if (!list.length) return parsed

  const derived = parsed.routines || []
  const byName = new Map(derived.map(r => [normName(r.name), r]))

  const out = [], adopted = new Set()
  for (const r of list) {
    const twin = byName.get(normName(r.name))
    if (twin) { adopted.add(twin.id); out.push({ ...r, id: twin.id, sessions: twin.sessions }) }
    else out.push(r)
  }
  // Derived routines Hevy no longer has. Their sessions still point at them.
  for (const d of derived) if (!adopted.has(d.id)) out.push(d)

  // A name the derivation refused (too few sessions, too varied) but Hevy actually holds is
  // no longer a refusal worth reporting — the routine is right there in the result.
  const have = new Set(out.map(r => normName(r.name)))
  const skipped = (parsed.skippedRoutines || []).filter(s => !have.has(normName(s.name)))

  return {
    ...parsed,
    routines: out,
    skippedRoutines: skipped,
    customEx: [...(parsed.customEx || []), ...((real.customEx || []).filter(c => c))],
    unmatchedNames: [...new Set([...(parsed.unmatchedNames || []), ...(real.unmatchedNames || [])])].sort(),
    realRoutines: list.length,
  }
}
