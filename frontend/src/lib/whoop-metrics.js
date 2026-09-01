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
  recovery:   { cols: ['recovery score percent', 'recovery score'], range: [0, 100] },
  hrv:        { cols: ['heart rate variability rmssd ms', 'heart rate variability ms', 'heart rate variability', 'hrv rmssd'], range: [1, 300] },
  rhr:        { cols: ['resting heart rate bpm', 'resting heart rate', 'resting hr'], range: [25, 120] },
  spo2:       { cols: ['blood oxygen percent', 'blood oxygen', 'spo2'], range: [70, 100] },
  skinTemp:   { cols: ['skin temp celsius', 'skin temperature celsius', 'skin temp'], range: [20, 45] },
  strain:     { cols: ['day strain', 'cycle strain'], range: [0, 21] },
  maxHr:      { cols: ['max hr bpm', 'max heart rate'], range: [80, 230] },
  avgHr:      { cols: ['average hr bpm', 'average heart rate', 'avg hr'], range: [35, 200] },
  sleepPerf:  { cols: ['sleep performance percent', 'sleep performance'], range: [0, 100] },
  sleepEff:   { cols: ['sleep efficiency percent', 'sleep efficiency'], range: [0, 100] },
  sleepCons:  { cols: ['sleep consistency percent', 'sleep consistency'], range: [0, 100] },
  sleepDur:   { cols: ['asleep duration min', 'asleep duration minutes', 'total sleep time'], range: [1, 1440] },
  inBed:      { cols: ['in bed duration min', 'in bed duration minutes', 'time in bed'], range: [1, 1440] },
  sleepNeed:  { cols: ['sleep need min', 'sleep need minutes'], range: [1, 1440] },
  sleepDebt:  { cols: ['sleep debt min', 'sleep debt minutes'], range: [0, 1440] },
  rem:        { cols: ['rem duration min', 'rem duration minutes', 'rem sleep'], range: [0, 1440] },
  deep:       { cols: ['deep sws duration min', 'deep sws duration minutes', 'deep sleep duration min', 'slow wave sleep'], range: [0, 1440] },
  light:      { cols: ['light sleep duration min', 'light sleep duration minutes'], range: [0, 1440] },
  awake:      { cols: ['awake duration min', 'awake duration minutes', 'awake time'], range: [0, 1440] },
  respRate:   { cols: ['respiratory rate rpm', 'respiratory rate', 'resp rate'], range: [5, 40] },
}

/**
 * The metrics a night of sleep produces, as opposed to the ones a day of wearing it does.
 *
 * Only used to decide whether a row with no wake onset is safe to date by its cycle start —
 * see parseWhoopMetricsCsv. Recovery is in here because Whoop scores it from the night.
 */
const SLEEP_KEYS = new Set([
  'recovery', 'sleepPerf', 'sleepEff', 'sleepCons', 'sleepDur', 'inBed',
  'sleepNeed', 'sleepDebt', 'rem', 'deep', 'light', 'awake', 'respRate',
])

/**
 * Energy is matched separately because the unit lives in the header and nowhere else.
 *
 * Some exports write kilojoules. Guessing from magnitude is the obvious shortcut and it is a
 * trap: 2,000 kcal and 8,368 kJ are the same day, both are plausible-looking numbers, and a
 * threshold that catches the big ones rewrites a genuine 4,500 kcal effort as 1,076. So the
 * unit is read from whichever header matched, and a header carrying no unit at all is
 * skipped. A missing calorie figure is honest; a wrong one is not.
 */
export const ENERGY_COLS = [
  { cols: ['energy burned kilojoules', 'energy burned kilojoule', 'energy burned kj'], kcal: v => v / 4.184 },
  { cols: ['energy burned kilocalories', 'energy burned kcal', 'energy burned cal'], kcal: v => v },
]
export const KCAL_RANGE = [200, 12000]

/**
 * Which column dates the row — and the order is the whole point.
 *
 * A Whoop cycle runs from one sleep onset to the next, so `Cycle start time` is the moment
 * you fell asleep, which for most people is the *previous* calendar evening. Dating a row by
 * it files every night's recovery one day early, which is wrong for essentially every row and
 * invisible unless you go looking. `Wake onset` is the day you wake into, and that is the day
 * a recovery score describes.
 */
const DATE_COLS = ['wake onset', 'sleep onset', 'cycle start time', 'start time', 'date']

/** sleeps.csv marks naps; they get no recovery and must not displace the night. */
const NAP_COLS = ['nap']
const isTrue = v => /^(true|yes|1)$/i.test(String(v ?? '').trim())

const round1 = n => Math.round(n * 10) / 10

/**
 * A resolved column is kept only if its own values look like the metric it claims to be.
 *
 * Sampled and judged on the fraction that pass, rather than row by row, because an empty cell
 * is normal in this export (a Whoop 3.0 records no SpO2 at all) and one absurd row should not
 * discard a good column. The 70% bar is the same shape of test import-health.js applies to
 * Health Connect's unlabelled columns.
 */
function columnHolds(rows, idx, [lo, hi], map = v => v) {
  let seen = 0, ok = 0
  for (const r of rows) {
    const raw = String(r[idx] ?? '').trim()
    if (!raw) continue
    const v = map(num(raw))
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

  // A cycle you did not sleep in still has a day in it.
  //
  // Rows are dated by wake onset, because that is the morning a night's sleep and recovery
  // describe. But a cycle where the band recorded no sleep has an empty wake onset — and
  // dating by it alone therefore discards the whole row, including the strain, calories and
  // heart rate it does carry. Six rows of a real five-month export went that way carrying a
  // day's strain, two of them 13.7 and 14.7 — substantial training, absent from the strain
  // series and from every acute-against-chronic read taken over it. Five were days with no
  // other record at all; the sixth shared its date with a night, which is the case the
  // fill-only rule below exists for.
  //
  // The cycle's own start date is the fallback, and it is unambiguous for exactly the reason
  // the row qualifies: there is no sleep on it to misfile. Applied per row, and only when
  // the sleep block is genuinely empty, so a row that has sleep is never dated by anything
  // but its wake onset.
  const startIdx = findCol(header, 'cycle start time', 'start time')

  // Resolve whichever metrics this file happens to carry, keeping only the columns whose
  // values agree with what they claim to be.
  const cols = {}
  for (const [key, spec] of Object.entries(METRICS)) {
    const i = findCol(header, ...spec.cols)
    if (i >= 0 && columnHolds(body, i, spec.range)) cols[key] = i
  }
  // Energy is resolved by the unit in its own header rather than with the rest, and checked
  // on converted values — a kilojoule column reads as a plausible calorie count otherwise.
  let energy = null
  for (const spec of ENERGY_COLS) {
    const i = findCol(header, ...spec.cols)
    if (i >= 0 && columnHolds(body, i, KCAL_RANGE, spec.kcal)) { energy = { i, ...spec }; break }
  }
  if (energy) cols.kcal = energy.i

  const found = Object.keys(cols)
  if (!found.length) return { error: 'unrecognised' }

  const napIdx = findCol(header, ...NAP_COLS)

  const byDate = new Map()
  let skipped = 0, naps = 0
  for (const r of body) {
    // A nap earns no recovery and must not displace the night it shares a date with. Where
    // the column exists this is exact; where it does not, the duration tiebreak below is the
    // fallback, since the night is reliably the longer of the two.
    if (napIdx >= 0 && isTrue(r[napIdx])) { naps++; continue }
    let d = dayOf(r[dateIdx])
    // No wake onset: fall back to the cycle's start date, but only for a row whose sleep
    // block is empty, and then only to fill gaps — a row dated by its own wake onset is the
    // better authority for a day and must not be overwritten by one dated this way.
    let viaStart = false
    if (!d && startIdx >= 0 && startIdx !== dateIdx &&
        !found.some(k => SLEEP_KEYS.has(k) && String(r[cols[k]] ?? '').trim())) {
      d = dayOf(r[startIdx])
      viaStart = true
    }
    if (!d) { skipped++; continue }
    const row = byDate.get(d) || { d }
    let wrote = false
    for (const key of found) {
      const raw = String(r[cols[key]] ?? '').trim()
      if (!raw) continue
      const v = num(raw)
      if (!isFinite(v)) continue
      const [lo, hi] = key === 'kcal' ? KCAL_RANGE : METRICS[key].range
      const val = key === 'kcal' ? energy.kcal(v) : v
      if (val < lo || val > hi) continue
      // A nap adds a second sleeps.csv row for the same day. The night is the long one, so
      // the larger duration wins rather than whichever row happened to come last.
      if (key === 'sleepDur' && row.sleepDur != null && row.sleepDur >= val) continue
      // Two cycles can share a calendar day — one that ended in sleep, one that did not.
      // The wake-onset row owns the day; this one only fills what it left empty.
      if (viaStart && row[key] != null) continue
      row[key] = round1(val)
      wrote = true
    }
    if (wrote) byDate.set(d, row)
    else skipped++
  }
  if (!byDate.size) return { error: 'unrecognised' }
  return { rows: byDate, found, skipped, naps }
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

/**
 * What a header line would and would not resolve to — for when an import fails.
 *
 * "That file's columns aren't recognised" is a dead end. It tells somebody holding a genuine
 * export nothing about which of the two possible faults they have: a Whoop variant this
 * importer has not met, or a file that was never a Whoop export. Both look identical from
 * outside, and only one is worth reporting.
 *
 * So on failure the app shows the header it actually read and what each column resolved to.
 * That turns a dead end into either an answer ("this is the wrong file") or a bug report good
 * enough to act on without asking anyone to send their health data.
 *
 * @returns {{date: string|null, matched: Array, unmatched: string[], columns: string[]}}
 */
export function diagnoseHeader(header) {
  const cols = Array.isArray(header) ? header.map(h => String(h ?? '')) : []
  const dateIdx = findCol(cols, ...DATE_COLS)
  const matched = []
  const taken = new Set()
  if (dateIdx >= 0) taken.add(dateIdx)

  for (const [key, spec] of Object.entries(METRICS)) {
    const i = findCol(cols, ...spec.cols)
    if (i >= 0) { matched.push({ key, column: cols[i] }); taken.add(i) }
  }
  for (const spec of ENERGY_COLS) {
    const i = findCol(cols, ...spec.cols)
    if (i >= 0) { matched.push({ key: 'kcal', column: cols[i] }); taken.add(i); break }
  }
  return {
    date: dateIdx >= 0 ? cols[dateIdx] : null,
    matched,
    unmatched: cols.filter((_, i) => !taken.has(i)),
    columns: cols,
  }
}

/** True if a CSV header looks like one of Whoop's physiological exports. */
export function isWhoopMetrics(header) {
  if (findCol(header, ...DATE_COLS) < 0) return false
  return ['recovery', 'hrv', 'rhr', 'strain', 'sleepPerf', 'sleepDur', 'sleepEff', 'respRate']
    .some(k => findCol(header, ...METRICS[k].cols) >= 0)
}
