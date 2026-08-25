// Import from the health platforms, as opposed to the workout-logging apps in import-csv.js.
//
// Three sources, and they are not equally cooperative:
//
//   Google Fit (Google Takeout)  Takeout/Fit/**. Body weight arrives two ways — a column in
//                                the "Daily activity metrics" CSVs, and one datapoint per
//                                weigh-in in All Data/*weight*.json. The JSON is finer
//                                grained, so it wins where both are present.
//   Whoop (account data export)  a zip of four CSVs. Whoop has no scale and no reps, so the
//                                only thing here the app can hold is workouts.csv, which
//                                becomes cardio sessions.
//   Health Connect              exports a raw SQLite database, not CSV — see sqlite.js.
//
// WHAT IS AND ISN'T PINNED DOWN. Google's Takeout column names are documented and matched
// here literally. Whoop's are NOT published anywhere I could verify, so nothing here depends
// on an exact Whoop header: columns are found by matching keywords against the normalised
// header text, and a file whose columns don't resolve is reported rather than guessed at.
// That asymmetry is deliberate. A wrong header does not throw — it silently files a year of
// training under the wrong numbers, which is far worse than refusing the file. The
// confirm-first sheet in sheets.jsx is the second line of defence: nothing is written until
// the parsed dates, counts and units are on screen.

import { parseCSV, parseWhen, matchExercise, norm, num, toMinutes, LB_TO_KG } from './import-csv.js'
import { openSqlite, looksLikeSqlite } from './sqlite.js'
import { parseWhoopMetricsCsv, mergeWhoopMetrics, isWhoopMetrics } from './whoop-metrics.js'
import { uid } from './format.js'

/* ------------------------------------------------------------------ util -- */

/** Index of the first header whose normalised text contains every word in `want`. */
export function findCol(header, ...alternatives) {
  const H = header.map(norm)
  for (const want of alternatives) {
    const words = norm(want).split(' ').filter(Boolean)
    const i = H.findIndex(h => words.every(w => h.split(' ').includes(w)))
    if (i >= 0) return i
  }
  return -1
}

// A body weight outside this range is a unit error, not a person. Health Connect stores
// grams, some exports store pounds, and a stray column can line up with a step count — all
// of which produce numbers that are obviously not a body weight. Rejecting them keeps a
// mis-read out of the log instead of writing 78400 kg into somebody's chart.
const MIN_KG = 20, MAX_KG = 400
const plausibleKg = w => w >= MIN_KG && w <= MAX_KG

const round1 = n => Math.round(n * 10) / 10
const isoOf = ms => new Date(ms).toISOString().slice(0, 10)

/**
 * Collapse weigh-ins to one per day (the last), then shape them the way the store wants.
 * `unit` is the profile's unit; values arrive in kg and are converted only if it isn't.
 */
function bodyweightResult(byDate, source, unit) {
  const dates = [...byDate.keys()].sort()
  if (!dates.length) return { error: 'unrecognised' }
  const conv = unit === 'lb' ? w => round1(w / LB_TO_KG) : w => round1(w)
  return {
    kind: 'bodyweight', source,
    bodyweight: dates.map(d => ({ d, w: conv(byDate.get(d).w), t: byDate.get(d).t })),
    fileUnit: 'kg', converted: unit === 'lb',
    from: dates[0], to: dates[dates.length - 1],
  }
}

/* ----------------------------------------------------- Google Fit: CSV ----- */

// Documented Takeout columns (as published for the Fit export): the per-day files key off
// "Start time", the roll-up off "Date", and weight is "Average weight (kg)" with Max/Min
// beside it. Metric is not optional in this export — Takeout writes kg regardless of the
// display unit the phone used — so there is no unit column to read.
export function parseGoogleFitCsv(text, { unit = 'kg' } = {}) {
  const rows = parseCSV(text)
  if (rows.length < 2) return { error: 'empty' }
  const header = rows[0]
  const wCol = findCol(header, 'average weight kg', 'weight kg', 'max weight kg', 'min weight kg')
  const dCol = findCol(header, 'date', 'start time')
  if (wCol < 0 || dCol < 0) return { error: 'unrecognised' }

  const byDate = new Map()
  let skipped = 0
  for (let i = 1; i < rows.length; i++) {
    const raw = String(rows[i][wCol] ?? '').trim()
    if (!raw) continue                       // most days have no weigh-in; that is not an error
    const when = parseWhen(String(rows[i][dCol] ?? ''))
    const w = num(raw)
    if (!when || !w) { skipped++; continue }
    if (!plausibleKg(w)) { skipped++; continue }
    byDate.set(when.d, { w, t: new Date(when.d).getTime() + (when.t ?? 0) })
  }
  const out = bodyweightResult(byDate, 'Google Fit', unit)
  if (!out.error) out.skipped = skipped
  return out
}

/* ---------------------------------------------------- Google Fit: JSON ----- */

/**
 * Body weight out of a Takeout All Data weight dump.
 *
 * The wrapper key has been "Data Points" in the exports I can find documented, but the
 * point shape is the stable part — a `value`/`fitValue` array carrying `fpVal`, and a
 * nanosecond epoch in `startTimeNanos`. So this walks whatever array of point-shaped
 * objects the file contains rather than insisting on the outer key, and ignores anything
 * that doesn't look like a weight.
 */
export function parseGoogleFitJson(text, { unit = 'kg' } = {}) {
  let doc
  try { doc = JSON.parse(text) } catch (e) { return { error: 'unrecognised' } }

  const points = []
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return
    if (Array.isArray(node)) {
      // a point carries both a timestamp and a value array; anything else is structure
      if (node.length && node.every(p => p && typeof p === 'object' && (p.fitValue || p.value))) points.push(...node)
      else node.forEach(n => walk(n, depth + 1))
      return
    }
    if (typeof node === 'object') Object.values(node).forEach(n => walk(n, depth + 1))
  }
  walk(doc)
  if (!points.length) return { error: 'unrecognised' }

  const byDate = new Map()
  let skipped = 0
  for (const p of points) {
    const vals = p.fitValue || p.value || []
    const first = Array.isArray(vals) ? vals[0] : null
    // `fpVal` may sit directly on the entry or inside a nested `value`
    const raw = first && (first.fpVal ?? first.value?.fpVal ?? first.intVal ?? first.value?.intVal)
    const w = typeof raw === 'number' ? raw : num(raw)
    // nanos as a string is normal here — the numbers are past 2^53 and JSON keeps them quoted
    const nanos = p.startTimeNanos ?? p.endTimeNanos ?? p.modifiedTimeMillis
    if (!w || nanos == null) { skipped++; continue }
    const ms = String(nanos).length > 15 ? Number(String(nanos).slice(0, 13)) : Number(nanos)
    if (!isFinite(ms) || ms <= 0) { skipped++; continue }
    if (!plausibleKg(w)) { skipped++; continue }
    byDate.set(isoOf(ms), { w, t: ms })
  }
  const out = bodyweightResult(byDate, 'Google Fit', unit)
  if (!out.error) out.skipped = skipped
  return out
}

/* -------------------------------------------------------------- Whoop ----- */

// Whoop's own vocabulary for its workout rows. None of these are published column names —
// they are keyword sets matched against whatever header the file actually has, in priority
// order, so a rename upstream degrades to "column not found" rather than to wrong data.
const WHOOP_COLS = {
  start: ['workout start time', 'start time', 'cycle start time'],
  end: ['workout end time', 'end time'],
  activity: ['activity name', 'sport name', 'activity'],
  duration: ['duration min', 'duration minutes', 'duration'],
  distance: ['distance meter', 'distance meters', 'distance km', 'distance'],
  strain: ['activity strain', 'strain'],
  energy: ['energy burned cal', 'calories'],
}

/** True if this looks like Whoop's workouts.csv, by header shape rather than file name. */
export function isWhoopWorkouts(header) {
  return findCol(header, ...WHOOP_COLS.activity) >= 0 &&
    findCol(header, ...WHOOP_COLS.start) >= 0 &&
    (findCol(header, ...WHOOP_COLS.strain) >= 0 || findCol(header, ...WHOOP_COLS.duration) >= 0)
}

/**
 * Whoop workouts -> cardio sessions.
 *
 * Whoop measures strain and heart rate; it has no idea what you lifted or how many times.
 * So a row can only become what this app calls a cardio entry: a duration, and a speed when
 * the row carried a distance. Strain, calories and heart rate are deliberately dropped —
 * there is nowhere in the model to show them, and inventing a field to hold a number nothing
 * reads back is how a schema rots.
 */
export function parseWhoopWorkouts(text, { unit = 'kg' } = {}) {
  const rows = parseCSV(text)
  if (rows.length < 2) return { error: 'empty' }
  const header = rows[0]
  const c = {}
  for (const k in WHOOP_COLS) c[k] = findCol(header, ...WHOOP_COLS[k])
  if (c.activity < 0 || c.start < 0) return { error: 'unrecognised' }

  const cell = (r, k) => (c[k] < 0 ? '' : String(r[c[k]] ?? '').trim())
  const byDate = new Map()
  const created = new Map()
  const unmatched = new Set()
  const resolved = new Map()
  let sets = 0, skipped = 0, matched = 0

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const name = cell(r, 'activity')
    const when = parseWhen(cell(r, 'start'))
    if (!name || !when) { skipped++; continue }

    // Duration: an explicit column if there is one, otherwise end - start.
    let mins = toMinutes(cell(r, 'duration'))
    if (!mins && c.end >= 0) {
      const a = Date.parse(cell(r, 'start')), b = Date.parse(cell(r, 'end'))
      if (isFinite(a) && isFinite(b) && b > a) mins = round1((b - a) / 60000)
    }
    // Distance: the header says which unit, so no guessing between metres and kilometres.
    const dRaw = num(cell(r, 'distance'))
    const dHead = c.distance >= 0 ? norm(header[c.distance]) : ''
    const km = !dRaw ? 0
      : dHead.includes('meter') || /\bm\b/.test(dHead) ? dRaw / 1000
        : dHead.includes('km') ? dRaw
          : dHead.includes('mile') || dHead.includes('mi') ? dRaw * 1.609344
            : dRaw / 1000
    if (!mins && !km) { skipped++; continue }

    const key = norm(name)
    let id = resolved.get(key)
    if (id === undefined) { id = matchExercise(name); resolved.set(key, id) }
    if (id) matched++
    else {
      let c2 = created.get(key)
      if (!c2) {
        c2 = { id: 'im' + uid(), n: name.toLowerCase(), custom: true, eq: 'custom', tg: '', desc: '', bp: 'cardio' }
        created.set(key, c2)
        unmatched.add(name)
      }
      id = c2.id
    }

    const set = { min: mins || 0, speed: mins > 0 && km > 0 ? round1(km / (mins / 60)) : 0, done: true }
    let day = byDate.get(when.d)
    if (!day) { day = { ex: new Map(), start: when.t, end: null }; byDate.set(when.d, day) }
    if (c.end >= 0) { const e = parseWhen(cell(r, 'end')); if (e && e.t != null) day.end = e.t }
    if (!day.ex.has(id)) day.ex.set(id, [])
    day.ex.get(id).push(set)
    sets++
  }

  const dates = [...byDate.keys()].sort()
  if (!dates.length) return { error: 'unrecognised' }
  const workouts = dates.map(d => {
    const day = byDate.get(d)
    const entries = [...day.ex.entries()].map(([id, ss]) => ({ id, sets: ss, topW: null }))
    const base = new Date(d + 'T00:00:00').getTime()
    const start = base + (day.start ?? 12 * 3600000)
    const end = day.end != null ? base + day.end : start
    return {
      id: 'iw' + uid(), d, start, end: end > start ? end : start,
      routineId: null, name: 'Whoop', entries, prs: [], vol: 0,
    }
  })

  return {
    kind: 'workouts', source: 'Whoop', workouts, customEx: [...created.values()],
    matched: new Set([...resolved.values()].filter(Boolean)).size,
    matchedSets: matched, created: created.size, unmatchedNames: [...unmatched].sort(),
    sets, skipped, warmups: 0,
    // Whoop reports no load at all, so there is nothing to convert and nothing to warn about.
    fileUnit: '', mixedUnits: false, converted: false, rpeSets: 0, rirSets: 0,
    from: dates[0], to: dates[dates.length - 1],
  }
}

/* ----------------------------------------------------- Health Connect ----- */

// Time can arrive in any of these. Health Connect's own schema is not published, and the
// column name ("time", "time_millis", "epoch_millis") does not reliably say which, so the
// magnitude decides: a timestamp for a date anyone has weighed themselves on has a known
// number of digits in each unit.
const TIME_SCALES = [
  { name: 's', to: v => v * 1000 },
  { name: 'ms', to: v => v },
  { name: 'us', to: v => v / 1000 },
  { name: 'ns', to: v => v / 1e6 },
]
const YEAR_2000 = 946684800000
const YEAR_2100 = 4102444800000
const plausibleMs = ms => ms > YEAR_2000 && ms < YEAR_2100

// Likewise the unit of the stored mass. Health Connect models mass in grams internally, but
// an exporter may well have written kilograms, so this is decided by the values themselves.
const MASS_SCALES = [
  { name: 'kg', to: v => v },
  { name: 'g', to: v => v / 1000 },
  { name: 'lb', to: v => v * LB_TO_KG },
]

const looksTimeCol = c => /time|date|epoch|milli|instant|start/i.test(c)
const looksMassCol = c => /weight|mass|value|kg|gram|amount/i.test(c)

/** The scale under which the most samples land in a plausible range. */
function bestScale(scales, samples, ok) {
  let best = null, bestHits = 0
  for (const s of scales) {
    const hits = samples.reduce((n, v) => n + (ok(s.to(v)) ? 1 : 0), 0)
    if (hits > bestHits) { best = s; bestHits = hits }
  }
  // A coincidence is not a detection: most of the column has to agree, not one lucky row.
  return bestHits >= Math.max(1, samples.length * 0.8) ? best : null
}

/**
 * Body weight out of a Health Connect database.
 *
 * The schema is not documented and I have no real backup to check against, so nothing here
 * is hardcoded to a table or column name. It looks for a weight-ish table, then decides
 * which column is the time and which is the mass — and in what units — from the values, by
 * requiring 80% of the samples to land in a range a human body weight and a real date
 * actually occupy. If no column pair survives that, it reports rather than guesses, and the
 * confirm sheet still shows the dates and numbers before anything is written.
 */
export function parseHealthConnectDb(db, { unit = 'kg' } = {}) {
  const candidates = db.tables.filter(t => /weight|mass/i.test(t.name) && t.columns.length >= 2)
  if (!candidates.length) return { error: 'no-weight-table' }

  for (const table of candidates) {
    const rows = db.rows(table.name, 50000)
    if (!rows.length) continue
    const nums = c => rows.map(r => Number(r[c])).filter(v => isFinite(v) && v !== 0)

    const timeCols = table.columns.filter(looksTimeCol)
    const massCols = table.columns.filter(c => looksMassCol(c) && !looksTimeCol(c))
    for (const tc of timeCols) {
      const tScale = bestScale(TIME_SCALES, nums(tc).slice(0, 200), plausibleMs)
      if (!tScale) continue
      for (const mc of massCols) {
        const mScale = bestScale(MASS_SCALES, nums(mc).slice(0, 200), plausibleKg)
        if (!mScale) continue

        const byDate = new Map()
        let skipped = 0
        for (const r of rows) {
          const t = Number(r[tc]), m = Number(r[mc])
          if (!isFinite(t) || !isFinite(m)) { skipped++; continue }
          const ms = tScale.to(t), kg = mScale.to(m)
          if (!plausibleMs(ms) || !plausibleKg(kg)) { skipped++; continue }
          byDate.set(isoOf(ms), { w: kg, t: ms })
        }
        if (!byDate.size) continue
        const out = bodyweightResult(byDate, 'Health Connect', unit)
        out.skipped = skipped
        // Surfaced so the confirm sheet can say what was assumed, rather than assuming quietly.
        out.readAs = { table: table.name, timeColumn: tc, massColumn: mc, storedUnit: mScale.name }
        return out
      }
    }
  }
  return { error: 'no-weight-table' }
}

/* ------------------------------------------------------------ archives ----- */

const baseOf = p => String(p).split('/').pop().toLowerCase()

/** Whoop names its physiology files predictably; the sniffer below is the fallback. */
const isWhoopMetricFile = name => /^(sleeps|physiological[_ ]?cycles)/i.test(baseOf(name))

const METRIC_META = new Set(['d', 't', 'src'])

/** Shape a merged daily series the way ImportSummary expects to describe it. */
function metricsResult(metrics, source) {
  const fields = [...new Set(metrics.flatMap(Object.keys))].filter(k => !METRIC_META.has(k))
  return {
    kind: 'metrics', source, metrics, fields,
    days: metrics.length, from: metrics[0].d, to: metrics[metrics.length - 1].d,
  }
}

/**
 * Decide what an archive is and pull the one thing worth reading out of it.
 *
 * `entries` is what unzip() returns. Routing is by file name first because both exports
 * have stable, meaningful names, and falls back to sniffing a CSV header — a Takeout folder
 * renamed by the user, or a single CSV somebody extracted by hand, should still work.
 *
 * @returns {Promise<object>} a parse result, or { error } — 'health-connect-sqlite' when the
 *   archive is a Health Connect backup, which needs the SQLite path instead.
 */
export async function parseArchive(entries, opts = {}) {
  const files = entries.filter(e => !e.dir)

  // Health Connect ships a SQLite database rather than a CSV, so it takes the other path.
  // bytes() is offered by unzip entries that hold binary; a text-only entry cannot be one.
  for (const e of files.filter(e => /\.db$|\.sqlite$|health[ _]?connect/i.test(e.name))) {
    if (!e.bytes) continue
    let raw
    try { raw = await e.bytes() } catch (err) { continue }
    if (!looksLikeSqlite(raw)) continue
    try {
      return parseHealthConnectDb(openSqlite(raw), opts)
    } catch (err) {
      return { error: 'unreadable-db' }
    }
  }

  // Whoop: one file per data type, and a single export carries several of them. They are
  // read together rather than first-match-wins, because one day is split across two files —
  // strain and recovery in physiological_cycles.csv, the sleep detail in sleeps.csv — so
  // stopping at the first hit would silently drop half of every day.
  const whoopMetrics = []
  for (const e of files.filter(e => isWhoopMetricFile(e.name) && e.name.endsWith('.csv'))) {
    const parsed = parseWhoopMetricsCsv(await e.text())
    if (!parsed.error) whoopMetrics.push(parsed)
  }
  const metrics = whoopMetrics.length ? mergeWhoopMetrics(whoopMetrics) : []

  const whoop = files.find(e => baseOf(e.name).startsWith('workouts'))
  if (whoop) {
    const parsed = parseWhoopWorkouts(await whoop.text(), opts)
    // Physiology rides along on the workouts result rather than becoming a second import the
    // user has to run: it came out of the same zip and describes the same days.
    if (!parsed.error) return metrics.length ? { ...parsed, metrics } : parsed
  }
  if (metrics.length) return metricsResult(metrics, 'Whoop')

  // Google Fit: prefer the per-weigh-in JSON, fall back to the daily CSV roll-up.
  const weightJson = files.filter(e => /weight/i.test(e.name) && e.name.endsWith('.json'))
  for (const f of weightJson) {
    const parsed = parseGoogleFitJson(await f.text(), opts)
    if (!parsed.error && parsed.bodyweight.length) return parsed
  }
  const dailyCsv = files.filter(e => /daily activity metrics/i.test(e.name) && e.name.endsWith('.csv'))
  // Takeout writes one file per day plus a roll-up; merging them all is what makes the
  // per-day folder usable at all, since each of those files holds a single row.
  if (dailyCsv.length) {
    const merged = new Map()
    let skipped = 0
    for (const f of dailyCsv) {
      const parsed = parseGoogleFitCsv(await f.text(), opts)
      if (parsed.error) continue
      skipped += parsed.skipped || 0
      for (const b of parsed.bodyweight) merged.set(b.d, b)
    }
    if (merged.size) {
      const dates = [...merged.keys()].sort()
      return {
        kind: 'bodyweight', source: 'Google Fit',
        bodyweight: dates.map(d => merged.get(d)),
        fileUnit: 'kg', converted: (opts.unit || 'kg') === 'lb', skipped,
        from: dates[0], to: dates[dates.length - 1],
      }
    }
  }

  // Nothing matched by name — sniff the CSVs for a header we recognise.
  for (const f of files.filter(e => e.name.endsWith('.csv'))) {
    const text = await f.text()
    const rows = parseCSV(text)
    if (rows.length < 2) continue
    if (isWhoopWorkouts(rows[0])) {
      const parsed = parseWhoopWorkouts(text, opts)
      if (!parsed.error) return parsed
    }
    if (isWhoopMetrics(rows[0])) {
      const parsed = parseWhoopMetricsCsv(text)
      if (!parsed.error) return metricsResult(mergeWhoopMetrics([parsed]), 'Whoop')
    }
    const parsed = parseGoogleFitCsv(text, opts)
    if (!parsed.error) return parsed
  }
  return { error: 'unrecognised' }
}

/** A loose CSV or JSON handed over on its own, rather than inside its archive. */
export function parseHealthText(text, opts = {}) {
  const s = String(text).trim()
  if (s.startsWith('{') || s.startsWith('[')) return parseGoogleFitJson(s, opts)
  const rows = parseCSV(s)
  if (rows.length < 2) return { error: 'empty' }
  if (isWhoopWorkouts(rows[0])) return parseWhoopWorkouts(s, opts)
  if (isWhoopMetrics(rows[0])) {
    const parsed = parseWhoopMetricsCsv(s)
    if (!parsed.error) return metricsResult(mergeWhoopMetrics([parsed]), 'Whoop')
    return parsed
  }
  return parseGoogleFitCsv(s, opts)
}
