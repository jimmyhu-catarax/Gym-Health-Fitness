import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGoogleFitCsv, parseGoogleFitJson, parseWhoopWorkouts,
  isWhoopWorkouts, parseArchive, parseHealthText, parseHealthConnectDb,
} from './import-health.js'
import { openSqlite } from './sqlite.js'
import { parseCSV } from './import-csv.js'

/* parseArchive takes whatever unzip() yields, so a test only needs objects of that shape.
   The real archive plumbing is covered by unzip.test.js; keeping the two apart means a
   routing test fails for a routing reason. */
const entry = (name, text) => ({
  name, dir: false, size: text.length,
  text: async () => text,
  bytes: async () => new TextEncoder().encode(text),
})
const binEntry = (name, bytes) => ({
  name, dir: false, size: bytes.length,
  bytes: async () => bytes,
  text: async () => new TextDecoder().decode(bytes),
})

// Health Connect's schema is not published, so these fixtures are a reconstruction of its
// shape: a weight table keyed by an epoch and a mass. The parser is written not to depend
// on the exact names or units, and the tests vary both on purpose to prove it.
let tmp, dbN = 0
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'hc-')) })
afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

function buildDb(fn) {
  const path = join(tmp, `hc${dbN++}.db`)
  const db = new DatabaseSync(path)
  fn(db)
  db.close()
  return readFileSync(path)
}
/** Grams and epoch millis, which is how Health Connect models mass internally. */
function hcDb() {
  return buildDb(db => {
    db.exec('CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'app_info_id INTEGER, time_millis INTEGER NOT NULL, zone_offset INTEGER, weight REAL NOT NULL)')
    const ins = db.prepare('INSERT INTO weight_record_table (app_info_id, time_millis, zone_offset, weight) VALUES (?,?,?,?)')
    ins.run(1, 1709769600000, 0, 78400)
    ins.run(1, 1709856000000, 0, 78100)
  })
}

// The Takeout header, as Google documents it for the Fit export.
const FIT_HEADER = 'Date,Move Minutes count,Calories (kcal),Distance (m),Heart Points,' +
  'Heart Minutes,Average heart rate (bpm),Max heart rate (bpm),Min heart rate (bpm),' +
  'Average speed (m/s),Max speed (m/s),Min speed (m/s),Step count,' +
  'Average weight (kg),Max weight (kg),Min weight (kg)'
const fitRow = (date, w) =>
  `${date},42,2100,3400,12,11,74,150,52,1.3,3.1,0.4,8400,${w},${w},${w}`

describe('Google Fit — daily activity metrics CSV', () => {
  it('reads body weight off the documented columns', () => {
    const csv = [FIT_HEADER, fitRow('2024-03-07', '78.4'), fitRow('2024-03-08', '78.1')].join('\n')
    const out = parseGoogleFitCsv(csv)
    expect(out.kind).toBe('bodyweight')
    expect(out.source).toBe('Google Fit')
    expect(out.bodyweight).toEqual([
      { d: '2024-03-07', w: 78.4, t: expect.any(Number) },
      { d: '2024-03-08', w: 78.1, t: expect.any(Number) },
    ])
    expect(out.from).toBe('2024-03-07')
    expect(out.to).toBe('2024-03-08')
  })

  it('passes over the days with no weigh-in instead of counting them as damage', () => {
    // Most days have steps but no weight. That is the normal case, not a broken row.
    const csv = [FIT_HEADER, fitRow('2024-03-07', '78.4'), fitRow('2024-03-08', ''), fitRow('2024-03-09', '')].join('\n')
    const out = parseGoogleFitCsv(csv)
    expect(out.bodyweight).toHaveLength(1)
    expect(out.skipped).toBe(0)
  })

  it('rejects a value that cannot be a body weight', () => {
    // Guards against a column slipping — a step count landing in the weight position.
    const csv = [FIT_HEADER, fitRow('2024-03-07', '8400'), fitRow('2024-03-08', '0.5')].join('\n')
    const out = parseGoogleFitCsv(csv)
    expect(out.error).toBe('unrecognised')
  })

  it('converts to lb for a profile that uses lb', () => {
    const csv = [FIT_HEADER, fitRow('2024-03-07', '80')].join('\n')
    const out = parseGoogleFitCsv(csv, { unit: 'lb' })
    expect(out.bodyweight[0].w).toBeCloseTo(176.4, 1)
    expect(out.converted).toBe(true)
  })

  it('keeps the file\'s own date across a DST boundary', () => {
    // 2024-03-10 is the US spring-forward. The date must survive as written rather than
    // sliding a day because it was pushed through a UTC conversion somewhere.
    const csv = [FIT_HEADER, fitRow('2024-03-10', '77.7')].join('\n')
    expect(parseGoogleFitCsv(csv).bodyweight[0].d).toBe('2024-03-10')
  })

  it('refuses a CSV with no weight column', () => {
    expect(parseGoogleFitCsv('Date,Step count\n2024-03-07,8400\n').error).toBe('unrecognised')
    expect(parseGoogleFitCsv('Date,Average weight (kg)\n').error).toBe('empty')
  })
})

describe('Google Fit — All Data weight JSON', () => {
  const doc = JSON.stringify({
    'Data Source': 'derived:com.google.weight:com.google.android.gms:merge_weight',
    'Data Points': [
      { fitValue: [{ value: { fpVal: 78.4 } }], startTimeNanos: '1709769600000000000', endTimeNanos: '1709769600000000000' },
      { fitValue: [{ value: { fpVal: 78.1 } }], startTimeNanos: '1709856000000000000', endTimeNanos: '1709856000000000000' },
    ],
  })

  it('reads fpVal against a nanosecond epoch', () => {
    const out = parseGoogleFitJson(doc)
    expect(out.kind).toBe('bodyweight')
    expect(out.bodyweight.map(b => b.w)).toEqual([78.4, 78.1])
    expect(out.bodyweight[0].d).toBe('2024-03-07')
  })

  it('accepts fpVal placed directly on the value entry', () => {
    // The REST shape and the Takeout shape differ by one level of nesting; both appear.
    const flat = JSON.stringify({ 'Data Points': [{ value: [{ fpVal: 81.2 }], startTimeNanos: '1709769600000000000' }] })
    expect(parseGoogleFitJson(flat).bodyweight[0].w).toBe(81.2)
  })

  it('does not depend on the wrapper key', () => {
    const odd = JSON.stringify({ whatever: { nested: [{ fitValue: [{ value: { fpVal: 79 } }], startTimeNanos: '1709769600000000000' }] } })
    expect(parseGoogleFitJson(odd).bodyweight[0].w).toBe(79)
  })

  it('drops points that are not a weight', () => {
    const mixed = JSON.stringify({
      'Data Points': [
        { fitValue: [{ value: { fpVal: 78.4 } }], startTimeNanos: '1709769600000000000' },
        { fitValue: [{ value: { intVal: 8400 } }], startTimeNanos: '1709856000000000000' },  // step count
        { fitValue: [{ value: { fpVal: 78.9 } }] },                                          // no timestamp
      ],
    })
    const out = parseGoogleFitJson(mixed)
    expect(out.bodyweight).toHaveLength(1)
    expect(out.skipped).toBe(2)
  })

  it('rejects text that is not JSON', () => {
    expect(parseGoogleFitJson('not json at all').error).toBe('unrecognised')
    expect(parseGoogleFitJson('{}').error).toBe('unrecognised')
  })
})

describe('Whoop — workouts.csv', () => {
  // Whoop's real headers are not published anywhere verifiable, so the parser matches on
  // keywords. These fixtures use the wording Whoop's own UI uses; the tests below deliberately
  // vary it to prove nothing depends on an exact string.
  const HEAD = 'Workout start time,Workout end time,Duration (min),Activity name,Activity Strain,Energy burned (cal),Max HR (bpm),Distance (meters)'
  const csv = [
    HEAD,
    '2024-03-07 06:30:00,2024-03-07 07:14:00,44,Running,11.2,540,178,8200',
    '2024-03-08 18:00:00,2024-03-08 18:45:00,45,Weightlifting,9.4,410,150,',
  ].join('\n')

  it('turns a workout row into a cardio session', () => {
    const out = parseWhoopWorkouts(csv)
    expect(out.kind).toBe('workouts')
    expect(out.source).toBe('Whoop')
    expect(out.workouts).toHaveLength(2)
    const run = out.workouts[0].entries[0].sets[0]
    expect(run.min).toBe(44)
    expect(run.speed).toBeCloseTo(11.2, 1)   // 8.2 km in 44 min
    expect(run.done).toBe(true)
  })

  it('leaves speed at zero when the row carried no distance', () => {
    const lift = parseWhoopWorkouts(csv).workouts[1].entries[0].sets[0]
    expect(lift.min).toBe(45)
    expect(lift.speed).toBe(0)
  })

  it('reads the distance unit off the header rather than assuming one', () => {
    const km = ['Workout start time,Duration (min),Activity name,Distance (km)',
      '2024-03-07 06:30:00,60,Running,12'].join('\n')
    expect(parseWhoopWorkouts(km).workouts[0].entries[0].sets[0].speed).toBeCloseTo(12, 1)
    const mi = ['Workout start time,Duration (min),Activity name,Distance (miles)',
      '2024-03-07 06:30:00,60,Running,6'].join('\n')
    expect(parseWhoopWorkouts(mi).workouts[0].entries[0].sets[0].speed).toBeCloseTo(9.7, 1)
  })

  it('falls back to end minus start when there is no duration column', () => {
    const noDur = ['Workout start time,Workout end time,Activity name,Activity Strain',
      '2024-03-07 06:30:00,2024-03-07 07:00:00,Running,8'].join('\n')
    expect(parseWhoopWorkouts(noDur).workouts[0].entries[0].sets[0].min).toBe(30)
  })

  it('survives a quoted comma inside an activity name', () => {
    // The failure this guards against is silent: splitting on commas shifts every later
    // column by one, and the whole file imports wrong without erroring.
    const quoted = ['Workout start time,Duration (min),Activity name,Activity Strain',
      '2024-03-07 06:30:00,30,"Functional Fitness, Outdoor",7.5'].join('\n')
    const out = parseWhoopWorkouts(quoted)
    expect(out.unmatchedNames).toEqual(['Functional Fitness, Outdoor'])
    expect(out.workouts[0].entries[0].sets[0].min).toBe(30)
  })

  it('skips rows with neither a duration nor a distance', () => {
    const partial = [HEAD,
      '2024-03-07 06:30:00,2024-03-07 06:30:00,,Running,,,,',
      '2024-03-08 18:00:00,2024-03-08 18:45:00,45,Cycling,9.4,410,150,'].join('\n')
    const out = parseWhoopWorkouts(partial)
    expect(out.skipped).toBe(1)
    expect(out.workouts).toHaveLength(1)
  })

  it('reports no unit conversion, because Whoop logs no load', () => {
    const out = parseWhoopWorkouts(csv)
    expect(out.converted).toBe(false)
    expect(out.mixedUnits).toBe(false)
    expect(out.fileUnit).toBe('')
  })

  it('recognises the file by header shape, under a different wording', () => {
    expect(isWhoopWorkouts(parseCSV(csv)[0])).toBe(true)
    expect(isWhoopWorkouts(parseCSV('Start time,Sport name,Strain\n')[0])).toBe(true)
    expect(isWhoopWorkouts(parseCSV('Date,Exercise,Weight,Reps\n')[0])).toBe(false)
  })

  it('refuses a file whose columns do not resolve', () => {
    expect(parseWhoopWorkouts('a,b,c\n1,2,3\n').error).toBe('unrecognised')
    expect(parseWhoopWorkouts('').error).toBe('empty')
  })
})

describe('parseArchive', () => {
  it('finds Whoop workouts among the other three exports', async () => {
    const out = await parseArchive([
      entry('my_whoop_data/sleeps.csv', 'Cycle start time,Sleep performance %\n2024-03-07,88\n'),
      entry('my_whoop_data/physiological_cycles.csv', 'Cycle start time,Recovery score %\n2024-03-07,64\n'),
      entry('my_whoop_data/journal_entries.csv', 'Cycle start time,Question text,Answered yes\n2024-03-07,Caffeine,true\n'),
      entry('my_whoop_data/workouts.csv',
        'Workout start time,Duration (min),Activity name,Activity Strain\n2024-03-07 06:30:00,44,Running,11.2\n'),
    ])
    expect(out.source).toBe('Whoop')
    expect(out.workouts).toHaveLength(1)
    // The physiology rides along on the same result: it came out of the same zip and
    // describes the same days, so it must not become a second import to run by hand.
    expect(out.metrics).toHaveLength(1)
    expect(out.metrics[0]).toMatchObject({ d: '2024-03-07', sleepPerf: 88, recovery: 64 })
  })

  it('takes the physiology on its own when the export has no workouts', async () => {
    const out = await parseArchive([
      entry('my_whoop_data/physiological_cycles.csv',
        'Cycle start time,Recovery score %,Heart rate variability (ms),Day Strain\n' +
        '2024-03-07 03:00:00,64,44.1,12.0\n2024-03-08 03:00:00,71,49.8,7.4\n'),
    ])
    expect(out.kind).toBe('metrics')
    expect(out.source).toBe('Whoop')
    expect(out.days).toBe(2)
    expect(out.from).toBe('2024-03-07')
    expect(out.to).toBe('2024-03-08')
    expect(out.fields.sort()).toEqual(['hrv', 'recovery', 'strain'])
  })

  it('joins a day split across the two physiology files', async () => {
    // Strain lives in one file and the sleep detail in the other. Stopping at the first
    // match would silently drop half of every day.
    const out = await parseArchive([
      entry('my_whoop_data/physiological_cycles.csv',
        'Cycle start time,Recovery score %,Day Strain\n2024-03-07 03:00:00,64,12.0\n'),
      entry('my_whoop_data/sleeps.csv',
        'Cycle start time,Asleep duration (min),REM duration (min)\n2024-03-07 03:00:00,441,92\n'),
    ])
    expect(out.metrics[0]).toMatchObject({ d: '2024-03-07', recovery: 64, strain: 12, sleepDur: 441, rem: 92 })
  })

  it('recognises a renamed physiology export by its header', async () => {
    const out = await parseArchive([
      entry('export/data-2.csv',
        'Cycle start time,Recovery score %,Resting heart rate (bpm)\n2024-03-07 03:00:00,64,52\n'),
    ])
    expect(out.kind).toBe('metrics')
    expect(out.metrics[0].rhr).toBe(52)
  })

  it('prefers the per-weigh-in JSON over the daily roll-up', async () => {
    // The CSV holds one averaged number per day; the JSON holds the weigh-ins themselves.
    const out = await parseArchive([
      entry('Takeout/Fit/Daily activity metrics/2024-03-07.csv', [FIT_HEADER, fitRow('2024-03-07', '78.9')].join('\n')),
      entry('Takeout/Fit/All Data/derived_com.google.weight_com.google.android.gms.json', JSON.stringify({
        'Data Points': [{ fitValue: [{ value: { fpVal: 78.4 } }], startTimeNanos: '1709769600000000000' }],
      })),
    ])
    expect(out.source).toBe('Google Fit')
    expect(out.bodyweight[0].w).toBe(78.4)
  })

  it('merges the one-row-per-day CSVs Takeout writes', async () => {
    const out = await parseArchive([
      entry('Takeout/Fit/Daily activity metrics/2024-03-07.csv', [FIT_HEADER, fitRow('2024-03-07', '78.4')].join('\n')),
      entry('Takeout/Fit/Daily activity metrics/2024-03-08.csv', [FIT_HEADER, fitRow('2024-03-08', '78.1')].join('\n')),
      entry('Takeout/Fit/Daily activity metrics/2024-03-09.csv', [FIT_HEADER, fitRow('2024-03-09', '')].join('\n')),
    ])
    expect(out.bodyweight.map(b => b.d)).toEqual(['2024-03-07', '2024-03-08'])
  })

  it('reads the SQLite database out of a Health Connect backup', async () => {
    const out = await parseArchive([binEntry('Health Connect/health_connect_export.db', hcDb())])
    expect(out.source).toBe('Health Connect')
    expect(out.bodyweight.map(b => b.w)).toEqual([78.4, 78.1])
  })

  it('passes over a .db that is not actually a database', async () => {
    const out = await parseArchive([binEntry('export.db', new TextEncoder().encode('not a database'))])
    expect(out.error).toBe('unrecognised')
  })

  it('still recognises a file whose folder was renamed', async () => {
    const out = await parseArchive([
      entry('stuff/export-2024.csv',
        'Workout start time,Duration (min),Activity name,Activity Strain\n2024-03-07 06:30:00,44,Running,11.2\n'),
    ])
    expect(out.source).toBe('Whoop')
  })

  it('reports an archive with nothing it can use', async () => {
    const out = await parseArchive([entry('notes.txt', 'hello'), entry('a.csv', 'x,y\n1,2\n')])
    expect(out.error).toBe('unrecognised')
  })

  it('ignores directory entries', async () => {
    const out = await parseArchive([
      { name: 'Takeout/Fit/', dir: true, text: async () => '' },
      entry('Takeout/Fit/Daily activity metrics/2024-03-07.csv', [FIT_HEADER, fitRow('2024-03-07', '78.4')].join('\n')),
    ])
    expect(out.bodyweight).toHaveLength(1)
  })
})

describe('parseHealthText — a loose file, outside its archive', () => {
  it('reads a Google Fit CSV', () => {
    expect(parseHealthText([FIT_HEADER, fitRow('2024-03-07', '78.4')].join('\n')).source).toBe('Google Fit')
  })
  it('reads a Whoop CSV', () => {
    expect(parseHealthText('Workout start time,Duration (min),Activity name,Activity Strain\n2024-03-07 06:30:00,44,Running,11\n').source).toBe('Whoop')
  })
  it('reads a weight JSON', () => {
    const doc = JSON.stringify({ 'Data Points': [{ fitValue: [{ value: { fpVal: 78.4 } }], startTimeNanos: '1709769600000000000' }] })
    expect(parseHealthText(doc).kind).toBe('bodyweight')
  })
  it('rejects everything else', () => {
    expect(parseHealthText('hello').error).toBeTruthy()
  })
})

describe('Health Connect', () => {
  const parse = (bytes, opts) => parseHealthConnectDb(openSqlite(bytes), opts)

  it('reads weights stored in grams against epoch millis', () => {
    const out = parse(hcDb())
    expect(out.kind).toBe('bodyweight')
    expect(out.source).toBe('Health Connect')
    expect(out.bodyweight).toEqual([
      { d: '2024-03-07', w: 78.4, t: 1709769600000 },
      { d: '2024-03-08', w: 78.1, t: 1709856000000 },
    ])
  })

  it('says what it assumed, so the confirm sheet can show it', () => {
    // The schema is unverified, so the assumption is reported rather than made silently.
    expect(parse(hcDb()).readAs).toEqual({
      table: 'weight_record_table', timeColumn: 'time_millis', massColumn: 'weight', storedUnit: 'g',
    })
  })

  it('works out the mass unit from the values, not the column name', () => {
    const kg = buildDb(db => {
      db.exec('CREATE TABLE weight_records (row_id INTEGER PRIMARY KEY, epoch INTEGER, value REAL)')
      const ins = db.prepare('INSERT INTO weight_records (epoch, value) VALUES (?,?)')
      ins.run(1709769600000, 78.4); ins.run(1709856000000, 78.1)
    })
    const out = parse(kg)
    expect(out.readAs.storedUnit).toBe('kg')
    expect(out.bodyweight[0].w).toBe(78.4)
  })

  it('works out the time unit from the values too', () => {
    for (const [scale, mult] of [['s', 1e-3], ['us', 1e3], ['ns', 1e6]]) {
      const bytes = buildDb(db => {
        db.exec('CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY, time INTEGER, weight REAL)')
        const ins = db.prepare('INSERT INTO weight_record_table (time, weight) VALUES (?,?)')
        ins.run(Math.round(1709769600000 * mult), 78.4)
        ins.run(Math.round(1709856000000 * mult), 78.1)
      })
      expect(parse(bytes).bodyweight[0].d, scale).toBe('2024-03-07')
    }
  })

  it('converts to lb for a profile in lb', () => {
    expect(parse(hcDb(), { unit: 'lb' }).bodyweight[0].w).toBeCloseTo(172.8, 1)
  })

  it('refuses a database with no weight table rather than inventing one', () => {
    const bytes = buildDb(db => {
      db.exec('CREATE TABLE steps_record_table (row_id INTEGER PRIMARY KEY, time_millis INTEGER, count INTEGER)')
      db.prepare('INSERT INTO steps_record_table (time_millis, count) VALUES (?,?)').run(1709769600000, 8400)
    })
    expect(parse(bytes).error).toBe('no-weight-table')
  })

  it('refuses a weight table whose numbers are not weights', () => {
    // A column that survives the name check but holds nonsense must not be imported on the
    // strength of its name alone.
    const bytes = buildDb(db => {
      db.exec('CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY, time_millis INTEGER, weight REAL)')
      const ins = db.prepare('INSERT INTO weight_record_table (time_millis, weight) VALUES (?,?)')
      ins.run(1709769600000, 0.004); ins.run(1709856000000, 0.005)
    })
    expect(parse(bytes).error).toBe('no-weight-table')
  })

  it('will not accept a column where only the odd row looks plausible', () => {
    // 80% of samples have to agree, so one coincidence cannot carry a whole column.
    const bytes = buildDb(db => {
      db.exec('CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY, time_millis INTEGER, weight REAL)')
      const ins = db.prepare('INSERT INTO weight_record_table (time_millis, weight) VALUES (?,?)')
      ins.run(1709769600000, 78.4)
      for (let i = 1; i < 10; i++) ins.run(1709769600000 + i * 86400000, 9000 + i)
    })
    expect(parse(bytes).error).toBe('no-weight-table')
  })

  it('keeps one weigh-in per day', () => {
    const bytes = buildDb(db => {
      db.exec('CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY, time_millis INTEGER, weight REAL)')
      const ins = db.prepare('INSERT INTO weight_record_table (time_millis, weight) VALUES (?,?)')
      ins.run(1709769600000, 78.4)            // 2024-03-07 00:00Z
      ins.run(1709805600000, 79.0)            // same day, later
    })
    const out = parse(bytes)
    expect(out.bodyweight).toHaveLength(1)
    expect(out.bodyweight[0].w).toBe(79)
  })
})
