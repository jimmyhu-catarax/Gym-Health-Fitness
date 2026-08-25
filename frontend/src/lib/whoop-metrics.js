// Whoop's physiological data: sleep, recovery and strain.
//
// import-health.js reads Whoop's workouts.csv, and its header says the only thing the app can
// hold from that export is workouts. That was true when the model had nowhere to put a
// recovery score; it isn't any more. This module reads the other two files:
//
//   sleeps.csv                 one row per sleep or nap — duration, stages, performance,
//                              efficiency, respiratory rate
//   physiological_cycles.csv   one row per cycle (sleep onset to sleep onset) — recovery
//                              score, HRV, resting heart rate, day strain, energy burned
//
// Both collapse to one row per day in `S.metrics`, the same day-level shape as `S.bodyweight`,
// so re-importing an overlapping export is harmless.
//
// THE HEADERS ARE STILL NOT PUBLISHED. Whoop documents its *API* field names and units
// (developer.whoop.com) and those are what the ranges below are built from — recovery is a
// 0-100 score, `hrv_rmssd_milli` is milliseconds, sleep stage totals are milliseconds. The CSV
// export uses human-readable headers Whoop does not publish, so, exactly as in
// import-health.js, columns are matched on keywords and then **sanity-checked against their
// own values**. A column that resolves but whose numbers are impossible for that metric is
// dropped, not stored. A file where nothing resolves is refused.
//
// That second check earns its keep here, because this export is full of near-collisions:
// "Day Strain" beside "Activity Strain", "Asleep duration" beside "In bed duration", "Sleep
// performance %" beside "Sleep efficiency %". Keyword matching alone would happily file one
// as the other, and a recovery chart built on time-in-bed is wrong in a way nobody notices.

import { parseCSV, num } from './import-csv.js'
import { findCol } from './import-health.js'

/**
 * One entry per metric: which header words identify it, and what values it can possibly have.
 *
 * `range` is a refusal test, not a clamp. Whoop's own docs give the units; the bounds are the
 * physiologically possible envelope — wide enough that a real outlier survives, narrow enough
 * that a mis-matched column does not. An HRV of 4000 is a column of milliseconds of sleep that
 * lined up with the HRV keyword, not a person.
 *
 * Order matters inside `cols`: the most specific phrasing first, so "day strain" wins before a
 * bare "strain" can match the activity column sitting next to it.
 */
export const METRICS = {
  recovery:  { cols: ['recovery score percent', 'recovery score', 'recovery'], range: [0, 100] },
  hrv:       { cols: ['heart rate variability rmssd', 'heart rate variability', 'hrv rmssd', 'hrv'], range: [1, 300] },
  rhr:       { cols: ['resting heart rate', 'resting hr', 'rhr'], range: [25, 120] },
  spo2:      { cols: ['blood oxygen percent', 'blood oxygen', 'spo2'], range: [70, 100] },
  skinTemp:  { cols: ['skin temp celsius', 'skin temperature', 'skin temp'], range: [20, 45] },
  strain:    { cols: ['day strain', 'cycle strain'], range: [0, 21] },
  kcal:      { cols: ['energy burned cal', 'calories burned', 'energy burned'], range: [200, 12000] },
  sleepPerf: { cols: ['sleep performance percent', 'sleep performance'], range: [0, 100] },
  sleepEff:  { cols: ['sleep efficiency percent', 'sleep efficiency'], range: [0, 100] },
  sleepDur:  { cols: ['asleep duration min', 'asleep duration', 'total sleep time'], range: [1, 1440] },
  inBed:     { cols: ['in bed duration min', 'in bed duration', 'time in bed'], range: [1, 1440] },
  sleepNeed: { cols: ['sleep need min', 'sleep need'], range: [1, 1440] },
  rem:       { cols: ['rem duration min', 'rem duration', 'rem sleep'], range: [0, 1440] },
  deep:      { cols: ['deep sws duration min', 'deep sws duration', 'slow wave sleep', 'deep sleep'], range: [0, 1440] },
  light:     { cols: ['light sleep duration min', 'light sleep duration', 'light sleep'], range: [0, 1440] },
  awake:     { cols: ['awake duration min', 'awake duration', 'awake time'], range: [0, 1440] },
  respRate:  { cols: ['respiratory rate', 'resp rate'], range: [5, 40] },
}

/** Header words that identify the row's day. Whoop dates a cycle by when it started. */
const DATE_COLS = ['cycle start time', 'sleep onset', 'start time', 'date']

const round1 = n => Math.round(n * 10) / 10

/**
 * A resolved column is kept only if its own values look like the metric it claims to be.
 *
 * Sampled and judged on the fraction that pass, rather than row by row, because an empty cell
 * is normal in this export (a Whoop 3.0 records no SpO2 at all) and one absurd row should not
 * discard a good column. The 70% bar is the same shape of test import-health.js applies to
 * Health Connect's unlabelled columns.
 */
function columnHolds(rows, idx, [lo, hi]) {
  let seen = 0, ok = 0
  for (const r of rows) {
    const raw = String(r[idx] ?? '').trim()
    if (!raw) continue
    const v = num(raw)
    if (!isFinite(v)) continue
    // A zero where the metric cannot be zero means "not recorded", not "measured as zero":
    // Whoop writes 0 for a night it did not capture. Counting those as failures lets a run of
    // unrecorded nights discard a column that is fine on every night it actually has.
    if (v === 0 && lo > 0) continue
    seen++
    if (v >= lo && v <= hi) ok++
  }
  return seen > 0 && ok / seen >= 0.7
}

/** Whoop writes local timestamps like "2026-08-24 07:12:03". Take the calendar day. */
export function dayOf(cell) {
  const s = String(cell ?? '').trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  // Some locales export DD/MM/YYYY, others MM/DD/YYYY, and the file does not say which.
  // Ambiguous by construction, so it is read only when the day is unmistakable (>12);
  // otherwise the row is skipped rather than filed under a date that could be months out.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (m) {
    const a = +m[1], b = +m[2]
    if (a > 12 && b <= 12) return `${m[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`
    if (b > 12 && a <= 12) return `${m[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`
    return null
  }
  const t = Date.parse(s)
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

/**
 * Read one Whoop CSV into per-day metrics.
 *
 * Works on either file — they overlap in shape and differ only in which columns exist, so
 * there is no need to know which one this is, and no need to trust a filename.
 *
 * @returns {{rows: Map<string,object>, found: string[], skipped: number}|{error: string}}
 */
export function parseWhoopMetricsCsv(text) {
  const rows = parseCSV(text)
  if (rows.length < 2) return { error: 'empty' }
  const header = rows[0]
  const body = rows.slice(1)

  const dateIdx = findCol(header, ...DATE_COLS)
  if (dateIdx < 0) return { error: 'no-date' }

  // Resolve whichever metrics this file happens to carry, keeping only the columns whose
  // values agree with what they claim to be.
  const cols = {}
  for (const [key, spec] of Object.entries(METRICS)) {
    const i = findCol(header, ...spec.cols)
    if (i >= 0 && columnHolds(body, i, spec.range)) cols[key] = i
  }
  const found = Object.keys(cols)
  if (!found.length) return { error: 'unrecognised' }

  const byDate = new Map()
  let skipped = 0
  for (const r of body) {
    const d = dayOf(r[dateIdx])
    if (!d) { skipped++; continue }
    const row = byDate.get(d) || { d }
    let wrote = false
    for (const key of found) {
      const raw = String(r[cols[key]] ?? '').trim()
      if (!raw) continue
      const v = num(raw)
      if (!isFinite(v)) continue
      const [lo, hi] = METRICS[key].range
      if (v < lo || v > hi) continue
      // A nap adds a second sleeps.csv row for the same day. The night is the long one, so
      // the larger duration wins rather than whichever row happened to come last.
      if (key === 'sleepDur' && row.sleepDur != null && row.sleepDur >= v) continue
      row[key] = round1(v)
      wrote = true
    }
    if (wrote) byDate.set(d, row)
    else skipped++
  }
  if (!byDate.size) return { error: 'unrecognised' }
  return { rows: byDate, found, skipped }
}

/**
 * Merge several parsed files into one sorted daily series.
 *
 * A Whoop export splits a single day across two files — recovery and strain in
 * physiological_cycles.csv, the sleep detail in sleeps.csv — so a day is only whole once both
 * are read. Later files fill gaps but never overwrite a value an earlier file supplied, which
 * keeps the result stable regardless of the order the zip happens to list its entries.
 */
export function mergeWhoopMetrics(parsed, { t = Date.now(), src = 'Whoop' } = {}) {
  const byDate = new Map()
  for (const p of parsed) {
    if (!p || p.error) continue
    for (const [d, row] of p.rows) {
      const cur = byDate.get(d) || { d, t, src }
      for (const k in row) if (k !== 'd' && cur[k] == null) cur[k] = row[k]
      byDate.set(d, cur)
    }
  }
  return [...byDate.keys()].sort().map(d => byDate.get(d))
}

/**
 * Fold newly imported days into the profile's existing series.
 *
 * Same stance as the workout importers: a day already present is left alone, so importing
 * last month's export after this month's cannot overwrite good data with a partial re-read.
 */
export function mergeIntoMetrics(existing, incoming) {
  const have = new Map((existing || []).map(m => [m.d, m]))
  let added = 0, kept = 0
  for (const row of incoming || []) {
    if (have.has(row.d)) { kept++; continue }
    have.set(row.d, row); added++
  }
  return { metrics: [...have.keys()].sort().map(d => have.get(d)), added, kept }
}

/** True if a CSV header looks like one of Whoop's physiological exports. */
export function isWhoopMetrics(header) {
  if (findCol(header, ...DATE_COLS) < 0) return false
  return ['recovery', 'hrv', 'rhr', 'strain', 'sleepPerf', 'sleepDur']
    .some(k => findCol(header, ...METRICS[k].cols) >= 0)
}
