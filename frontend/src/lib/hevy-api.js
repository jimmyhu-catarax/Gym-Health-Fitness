// Hevy's own API, for people who would rather not export a file every time.
//
// The CSV path stays the primary one and this is deliberately a thin layer on top of it: the
// response is turned into the exact CSV Hevy itself exports, and then handed to
// `parseWorkoutCSV` like any other file. One code path from somebody else's training data
// into the log means the sync inherits every guard already written for it — exercise matching,
// custom exercises for the unmatched, unit handling, warm-up marking, routine rebuilding, and
// the confirm sheet that stands between all of it and anything being written.
//
// Writing a second, parallel JSON->state path would have been quicker and would have earned
// its own copy of each of those bugs.
//
// **This runs in the browser, against the user's own key.** Hevy sends
// `access-control-allow-origin: *` and lists `api-key` in its allowed headers, so the page
// calls the API directly; nothing proxies through this app's Node service, which stays what
// the README says it is. The key is the user's credential for their own account and is stored
// with the rest of the profile — see docs/IMPORTING.md.
//
// **Hevy Pro only.** The key comes from hevy.com/settings?developer, which is a paid feature.
// A free account cannot produce one, so the error path says that in those words rather than
// leaving somebody re-typing a key that was never going to work.
//
// On the shape of the response: it is read defensively, not trusted. Every field is looked up
// under its documented name and a couple of plausible spellings, then sanity-checked against
// its value, and a response where no workout resolves a time and an exercise is **refused**
// rather than turned into an empty or a wrong import. This is the same stance the CSV readers
// take, and for the same reason: silently filing a year of training under the wrong numbers is
// far worse than refusing the sync.

export const HEVY_BASE = 'https://api.hevyapp.com/v1'

/** Hevy's page cap. Larger values are rejected by the API. */
export const PAGE_SIZE = 10
/** Stop here rather than paginating forever if the API keeps claiming there is more. */
export const MAX_PAGES = 400

// Every sync refetches the whole history rather than asking for what changed. Hevy documents
// an events endpoint for incremental sync, but its response shape could not be verified here
// without a paid key, and a guessed incremental cursor that silently skips a fortnight is a
// worse bug than a slow sync. Day-level dedup already makes the refetch harmless — it just
// costs requests. Worth revisiting against a real key.

/** Thrown for every failure the user can act on; `code` is what the UI switches on. */
export class HevyError extends Error {
  constructor(code, message) { super(message); this.name = 'HevyError'; this.code = code }
}

/** First present key, so a rename on their side does not silently read as absent. */
const pick = (o, names) => {
  if (!o || typeof o !== 'object') return undefined
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n]
  return undefined
}

const numOr = (v, lo, hi) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && isFinite(n) && n >= lo && n <= hi ? n : null
}

/** An array of objects under any of `names`, or the value itself when already one. */
const listOf = (o, names) => {
  const v = pick(o, names)
  return Array.isArray(v) ? v : []
}

/**
 * One page of workouts.
 *
 * @param {string} key       the user's API key
 * @param {number} page      1-based, as the API counts
 * @returns {Promise<{workouts:Array, pageCount:number}>}
 */
export async function fetchPage(key, page = 1, { pageSize = PAGE_SIZE, base = HEVY_BASE, fetchFn, resource = 'workouts' } = {}) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null)
  if (!f) throw new HevyError('offline', 'No network available')
  if (!key || !String(key).trim()) throw new HevyError('no-key', 'No API key')

  let res
  try {
    res = await f(`${base}/${resource}?page=${page}&pageSize=${pageSize}`, {
      headers: { 'api-key': String(key).trim(), accept: 'application/json' },
    })
  } catch (e) {
    throw new HevyError('offline', 'Could not reach Hevy')
  }

  // 401 and 403 are different conversations: a wrong key is retypeable, a free account is not.
  if (res.status === 401) throw new HevyError('bad-key', 'Hevy did not accept that key')
  if (res.status === 403) throw new HevyError('needs-pro', 'The Hevy API is a Hevy Pro feature')
  if (res.status === 429) throw new HevyError('rate-limit', 'Hevy is rate-limiting this key')
  if (!res.ok) throw new HevyError('http', `Hevy returned ${res.status}`)

  let body
  try { body = await res.json() } catch (e) { throw new HevyError('shape', 'Hevy returned something unreadable') }

  // The envelope has moved before; take the items wherever they are rather than pinning
  // one spelling, but insist they are actually a list. The resource's own name is tried
  // first, so /routines reads `routines` and /workouts reads `workouts`.
  const names = [resource, 'data', 'results', 'items']
  const items = listOf(body, names)
  if (!items.length && !Array.isArray(body)) {
    const pc = numOr(pick(body, ['page_count', 'pageCount', 'total_pages']), 0, 1e6)
    // An empty page is only legitimate when the envelope itself parsed.
    if (pc === null && pick(body, names) === undefined) {
      throw new HevyError('shape', 'Hevy returned an unfamiliar response')
    }
  }
  const list = Array.isArray(body) ? body : items
  // `workouts` is the original name and stays for every existing caller; `items` is the
  // same list under a name that does not lie when the resource is routines.
  return {
    workouts: list,
    items: list,
    pageCount: numOr(pick(body, ['page_count', 'pageCount', 'total_pages']), 0, 1e6) ?? 1,
  }
}

/** Every workout the key can see, oldest page first. */
export async function fetchWorkouts(key, { pageSize = PAGE_SIZE, maxPages = MAX_PAGES, base = HEVY_BASE, fetchFn, onProgress } = {}) {
  const all = []
  let page = 1, pageCount = 1
  while (page <= pageCount && page <= maxPages) {
    const r = await fetchPage(key, page, { pageSize, base, fetchFn })
    all.push(...r.workouts)
    pageCount = r.pageCount || 1
    onProgress && onProgress({ page, pageCount, count: all.length })
    if (!r.workouts.length) break
    page++
  }
  return { workouts: all, truncated: pageCount > maxPages }
}

/**
 * Every routine the key can see.
 *
 * This is the part the derivation in `derive-routines.js` can only approximate. That reads
 * plans back out of what was trained, so it needs a title trained at least three times and
 * refuses anything it cannot see a pattern in. Hevy has the actual routines — including the
 * one written last night and never trained, which no amount of history will reveal.
 *
 * Failure here is deliberately **not** fatal to a sync: the workouts are the training log and
 * the routines are the plan on top of it, so a routines endpoint that 404s or changes shape
 * costs the plan, not the history. `syncHevy` catches it.
 */
export async function fetchRoutines(key, { pageSize = PAGE_SIZE, maxPages = MAX_PAGES, base = HEVY_BASE, fetchFn, onProgress } = {}) {
  const all = []
  let page = 1, pageCount = 1
  while (page <= pageCount && page <= maxPages) {
    const r = await fetchPage(key, page, { pageSize, base, fetchFn, resource: 'routines' })
    all.push(...r.items)
    pageCount = r.pageCount || 1
    onProgress && onProgress({ page, pageCount, count: all.length })
    if (!r.items.length) break
    page++
  }
  return { routines: all, truncated: pageCount > maxPages }
}

/* --------------------------------------------------------------- to CSV --- */

const Q = v => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// Hevy's own export header, so detectSource() names the app correctly and mapHeader() finds
// every column without a single new entry in COLUMNS.
export const HEVY_CSV_HEADER = [
  'title', 'start_time', 'end_time', 'description', 'exercise_title', 'superset_id',
  'exercise_notes', 'set_index', 'set_type', 'weight_kg', 'reps', 'distance_km',
  'duration_seconds', 'rpe',
]

/** ISO in, the format parseWhen() reads out. Anything unparseable comes back null. */
const stamp = v => {
  if (v == null) return null
  const ms = typeof v === 'number' ? (v > 1e11 ? v : v * 1000) : Date.parse(String(v))
  return isFinite(ms) ? new Date(ms).toISOString() : null
}

// Every set-level name this reads, under any spelling. What is left over on a real set object
// is reported back as `unread` — not as an error, since Hevy carries fields this app has no
// use for, but as the first place to look when the numbers come out wrong.
const KNOWN_SET_KEYS = new Set([
  'index', 'set_index', 'type', 'set_type', 'setType',
  'weight_kg', 'weightKg', 'weight', 'reps', 'repetitions', 'rpe',
  'duration_seconds', 'durationSeconds', 'duration',
  'distance_meters', 'distanceMeters', 'distance_km', 'distanceKm',
])

/** Below this share of sets carrying any measurement at all, the caller should stop and look. */
export const COVERAGE_FLOOR = 0.5

/**
 * Hevy's JSON, as the CSV Hevy would have exported.
 *
 * Refuses rather than guessing: if not one workout in the response resolves both a start time
 * and a named exercise, the shape is not what this understands and the caller is told so.
 *
 * The subtler failure is the one this reports on rather than throws for. A response whose
 * workouts and exercises resolve but whose *sets* do not — `weight_kg` renamed, say — would
 * otherwise import a year of training as empty sets, which is the silent-wrong-numbers case
 * that matters more than a refusal. So every set is counted: how many yielded a weight, reps,
 * a duration, a distance, and what field names went unread. Zero measurements across the whole
 * response is refused outright; a low share is handed back for the UI to put in front of the
 * user before anything is written.
 *
 * @returns {{csv:string, workouts:number, sets:number, coverage:object, unread:string[], measured:number}}
 */
export function workoutsToCsv(raw) {
  const list = Array.isArray(raw) ? raw : []
  const lines = [HEVY_CSV_HEADER.join(',')]
  let sets = 0, kept = 0, measured = 0
  const coverage = { weight: 0, reps: 0, duration: 0, distance: 0, rpe: 0 }
  const unread = new Set()

  for (const w of list) {
    const start = stamp(pick(w, ['start_time', 'startTime', 'start', 'created_at']))
    const end = stamp(pick(w, ['end_time', 'endTime', 'end']))
    const title = pick(w, ['title', 'name']) ?? ''
    const desc = pick(w, ['description', 'notes']) ?? ''
    const exercises = listOf(w, ['exercises'])
    if (!start || !exercises.length) continue

    let wroteOne = false
    for (const ex of exercises) {
      const exTitle = pick(ex, ['title', 'name', 'exercise_title'])
      const exNotes = pick(ex, ['notes', 'exercise_notes']) ?? ''
      const superset = pick(ex, ['superset_id', 'supersetId'])
      const exSets = listOf(ex, ['sets'])
      if (!exTitle || !exSets.length) continue

      exSets.forEach((s, i) => {
        // Ranges are the published plausible ones, not tight ones: the job here is to catch a
        // field that turned out to hold something else entirely, not to referee somebody's
        // training. A value outside them is dropped, and a set with nothing left is skipped
        // by parseWorkoutCSV on its own.
        const kg = numOr(pick(s, ['weight_kg', 'weightKg', 'weight']), 0, 1000)
        const reps = numOr(pick(s, ['reps', 'repetitions']), 0, 1000)
        const rpe = numOr(pick(s, ['rpe']), 1, 10)
        const secs = numOr(pick(s, ['duration_seconds', 'durationSeconds', 'duration']), 0, 86400)
        // Metres upstream, kilometres in the CSV — a raw 5000 read as km is a 5000 km run.
        const metres = numOr(pick(s, ['distance_meters', 'distanceMeters']), 0, 1e6)
        const kmDirect = numOr(pick(s, ['distance_km', 'distanceKm']), 0, 1000)
        const km = kmDirect != null ? kmDirect : metres != null ? metres / 1000 : null
        const type = pick(s, ['type', 'set_type', 'setType']) ?? ''

        if (kg) coverage.weight++
        if (reps) coverage.reps++
        if (secs) coverage.duration++
        if (km) coverage.distance++
        if (rpe != null) coverage.rpe++
        // A set is "measured" if anything at all came off it. A set with none is the one that
        // parseWorkoutCSV will skip, and a response made entirely of them is the silent failure.
        if (kg || reps || secs || km) measured++
        if (s && typeof s === 'object') {
          for (const k of Object.keys(s)) if (!KNOWN_SET_KEYS.has(k)) unread.add(k)
        }

        lines.push([
          title, start, end ?? '', desc, exTitle, superset ?? '', exNotes,
          pick(s, ['index', 'set_index']) ?? i, type,
          kg ?? '', reps ?? '', km ?? '', secs ?? '', rpe ?? '',
        ].map(Q).join(','))
        sets++
        wroteOne = true
      })
    }
    if (wroteOne) kept++
  }

  if (!kept) throw new HevyError('shape', 'Nothing in that response looked like a Hevy workout')
  // Workouts and exercises read, but not one number came off any set. Importing that would
  // file the whole history as empty sets, so it is refused with the names it did not read —
  // which is exactly the list somebody needs to file a bug against this mapper.
  if (sets && !measured) {
    throw new HevyError('fields', `Found ${sets} sets but could not read a weight, a rep count, `
      + `a duration or a distance from any of them`
      + (unread.size ? ` (unread fields: ${[...unread].sort().join(', ')})` : ''))
  }
  return {
    csv: lines.join('\n'), workouts: kept, sets, measured, coverage,
    unread: [...unread].sort(),
  }
}

/** The whole round trip: key in, CSV text out, ready for parseWorkoutCSV. */
export async function syncHevy(key, opts = {}) {
  const { workouts, truncated } = await fetchWorkouts(key, opts)
  if (!workouts.length) throw new HevyError('empty', 'That Hevy account has no workouts yet')

  // Routines are the plan sitting on top of the log, and the log is what a sync is for. By
  // this point the key has already worked, so a failure here is the routines endpoint itself
  // — a 404, a shape change — and losing the plan is not worth losing the history over. The
  // reason is kept rather than dropped: the confirm sheet says the routines could not be
  // read, so a silently plan-less sync cannot be mistaken for an account with no routines.
  let routines = [], routinesError = null
  if (opts.routines !== false) {
    try {
      routines = (await fetchRoutines(key, opts)).routines
    } catch (e) {
      routines = []
      routinesError = e instanceof HevyError ? e.code : 'http'
    }
  }
  return { ...workoutsToCsv(workouts), routines, routinesError, truncated }
}

/** What to put in front of the user for each failure. English source strings are the keys. */
export const HEVY_MESSAGE = {
  'no-key': 'Enter your Hevy API key first',
  'bad-key': 'Hevy did not accept that key — check it at hevy.com/settings?developer',
  'needs-pro': 'The Hevy API is a Hevy Pro feature, and a free account cannot create a key. Your CSV export still imports.',
  'rate-limit': 'Hevy is rate-limiting this key — try again in a minute',
  offline: 'Could not reach Hevy. Check your connection and try again.',
  http: 'Hevy returned an error',
  shape: "Hevy's response was not in a shape this understands — your CSV export still imports.",
  fields: 'Hevy sent workouts, but none of their sets carried a weight, reps, a duration or a distance. Nothing was imported — your CSV export still works.',
  empty: 'That Hevy account has no workouts yet',
}
