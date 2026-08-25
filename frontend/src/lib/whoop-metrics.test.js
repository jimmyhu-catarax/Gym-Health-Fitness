import { describe, it, expect } from 'vitest'
import {
  parseWhoopMetricsCsv, mergeWhoopMetrics, mergeIntoMetrics, isWhoopMetrics, dayOf, METRICS,
  diagnoseHeader,
} from './whoop-metrics.js'

/* Fixtures are written as real CSV text rather than pre-parsed objects, because the thing
   under test is whether this agrees with a file shaped like Whoop's — and an object literal
   would skip the only part that can actually go wrong. */
const csv = (header, ...rows) => [header, ...rows].join('\n') + '\n'

const CYCLES_HEADER =
  'Cycle start time,Cycle end time,Recovery score %,Heart rate variability (ms),' +
  'Resting heart rate (bpm),Day Strain,Energy burned (cal),Blood oxygen %,Skin temp (celsius)'
const CYCLES = csv(CYCLES_HEADER,
  '2026-08-20 03:11:00,2026-08-21 02:58:00,67,43.2,54,12.4,2450,96.1,33.7',
  '2026-08-21 02:58:00,2026-08-22 03:05:00,81,58.9,51,9.2,2210,95.8,33.5',
  '2026-08-22 03:05:00,2026-08-23 02:47:00,42,31.0,60,16.8,2890,96.4,34.1')

const SLEEPS_HEADER =
  'Cycle start time,Sleep performance %,Sleep efficiency %,Asleep duration (min),' +
  'In bed duration (min),REM duration (min),Deep (SWS) duration (min),Light sleep duration (min),' +
  'Awake duration (min),Sleep need (min),Respiratory rate (rpm)'
const SLEEPS = csv(SLEEPS_HEADER,
  '2026-08-20 03:11:00,88,92,452,498,96,78,278,32,480,14.8',
  '2026-08-21 02:58:00,92,94,478,505,101,88,289,21,485,14.6',
  '2026-08-22 03:05:00,61,86,331,385,62,48,221,54,480,15.1')

describe('parseWhoopMetricsCsv — physiological_cycles.csv', () => {
  it('reads every metric the file carries', () => {
    const r = parseWhoopMetricsCsv(CYCLES)
    expect(r.error).toBeUndefined()
    expect(r.found.sort()).toEqual(['hrv', 'kcal', 'recovery', 'rhr', 'skinTemp', 'spo2', 'strain'])
    const day = r.rows.get('2026-08-20')
    expect(day).toMatchObject({ recovery: 67, hrv: 43.2, rhr: 54, strain: 12.4, kcal: 2450 })
  })

  it('takes Day Strain, not the Activity Strain sitting beside it', () => {
    // The two columns are adjacent in a real export and both match a bare "strain". Reading
    // the wrong one turns a rest day with one hard workout into a high-strain day.
    const header = CYCLES_HEADER + ',Activity Strain'
    const r = parseWhoopMetricsCsv(csv(header,
      '2026-08-20 03:11:00,2026-08-21 02:58:00,67,43.2,54,12.4,2450,96.1,33.7,8.1',
      '2026-08-21 02:58:00,2026-08-22 03:05:00,81,58.9,51,9.2,2210,95.8,33.5,3.0'))
    expect(r.rows.get('2026-08-20').strain).toBe(12.4)
  })

  it('drops a column whose values are impossible for the metric it matched', () => {
    // An "HRV" column holding milliseconds of sleep resolves on keywords and is nonsense on
    // values. Silently storing it would put 27,000 ms on somebody's HRV chart.
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Recovery score %,Heart rate variability (ms)',
      '2026-08-20 03:11:00,67,27120000',
      '2026-08-21 02:58:00,81,28680000'))
    expect(r.found).toContain('recovery')
    expect(r.found).not.toContain('hrv')
    expect(r.rows.get('2026-08-20').hrv).toBeUndefined()
  })

  it('skips an individual out-of-range value without discarding the column', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Recovery score %',
      '2026-08-20 03:11:00,67',
      '2026-08-21 02:58:00,81',
      '2026-08-22 03:05:00,140',   // impossible: recovery is a percentage
      '2026-08-23 03:00:00,55'))
    expect(r.rows.get('2026-08-20').recovery).toBe(67)
    expect(r.rows.has('2026-08-22')).toBe(false)
    expect(r.rows.get('2026-08-23').recovery).toBe(55)
  })

  it('keeps a column that is good on the nights it was actually recorded', () => {
    // Whoop writes 0 for a night it did not capture. Three unrecorded nights out of five must
    // not discard a duration column that is correct on the two it has.
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Asleep duration (min)',
      '2026-08-20 03:11:00,452',
      '2026-08-21 02:58:00,0',
      '2026-08-22 03:05:00,0',
      '2026-08-23 03:00:00,0',
      '2026-08-24 03:00:00,478'))
    expect(r.found).toContain('sleepDur')
    expect(r.rows.get('2026-08-20').sleepDur).toBe(452)
    expect(r.rows.has('2026-08-21')).toBe(false)
  })

  it('tolerates the blank cells a 3.0 band leaves behind', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Recovery score %,Blood oxygen %',
      '2026-08-20 03:11:00,67,',
      '2026-08-21 02:58:00,81,'))
    expect(r.found).toEqual(['recovery'])
    expect(r.rows.get('2026-08-20').spo2).toBeUndefined()
  })
})

describe('parseWhoopMetricsCsv — sleeps.csv', () => {
  it('reads the sleep detail', () => {
    const r = parseWhoopMetricsCsv(SLEEPS)
    const day = r.rows.get('2026-08-20')
    expect(day).toMatchObject({
      sleepPerf: 88, sleepEff: 92, sleepDur: 452, inBed: 498,
      rem: 96, deep: 78, light: 278, awake: 32, respRate: 14.8,
    })
  })

  it('keeps asleep duration and time in bed apart', () => {
    // They differ by exactly the awake time, and confusing them silently inflates sleep by
    // however long you lay there — which is the number people actually care about.
    const r = parseWhoopMetricsCsv(SLEEPS)
    const day = r.rows.get('2026-08-20')
    expect(day.sleepDur).toBe(452)
    expect(day.inBed).toBe(498)
    expect(day.inBed).toBeGreaterThan(day.sleepDur)
  })

  it('keeps performance and efficiency apart', () => {
    const day = parseWhoopMetricsCsv(SLEEPS).rows.get('2026-08-20')
    expect(day.sleepPerf).toBe(88)
    expect(day.sleepEff).toBe(92)
  })

  it('lets the night beat the nap on a day holding both', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Asleep duration (min)',
      '2026-08-20 03:11:00,452',    // the night
      '2026-08-20 14:30:00,26'))    // an afternoon nap, same calendar day
    expect(r.rows.get('2026-08-20').sleepDur).toBe(452)
  })

  it('still prefers the night when the nap is listed first', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Asleep duration (min)',
      '2026-08-20 14:30:00,26',
      '2026-08-20 03:11:00,452'))
    expect(r.rows.get('2026-08-20').sleepDur).toBe(452)
  })
})

describe('dayOf', () => {
  it('reads Whoop’s ISO-ish local timestamp', () => {
    expect(dayOf('2026-08-20 03:11:00')).toBe('2026-08-20')
    expect(dayOf('2026-08-20T03:11:00Z')).toBe('2026-08-20')
  })
  it('reads a slash date only when the day is unmistakable', () => {
    expect(dayOf('25/08/2026')).toBe('2026-08-25')   // 25 cannot be a month
    expect(dayOf('08/25/2026')).toBe('2026-08-25')
  })
  it('refuses an ambiguous slash date rather than being months wrong', () => {
    // 05/08 is 5 August or 8 May depending on the exporter's locale, and the file does not say.
    expect(dayOf('05/08/2026')).toBeNull()
  })
  it('returns null on junk', () => {
    for (const v of ['', null, undefined, 'not a date']) expect(dayOf(v)).toBeNull()
  })
})

describe('refusals', () => {
  it('refuses a file with no date column', () => {
    expect(parseWhoopMetricsCsv(csv('Recovery score %,Day Strain', '67,12.4')).error).toBe('no-date')
  })
  it('refuses a file where no metric resolves', () => {
    expect(parseWhoopMetricsCsv(csv('Cycle start time,Notes', '2026-08-20 03:11:00,felt fine')).error)
      .toBe('unrecognised')
  })
  it('refuses an empty file', () => {
    expect(parseWhoopMetricsCsv('').error).toBe('empty')
    expect(parseWhoopMetricsCsv('Cycle start time,Recovery score %\n').error).toBe('empty')
  })
  it('refuses a header-only file rather than returning zero days', () => {
    expect(parseWhoopMetricsCsv(csv('Cycle start time,Recovery score %')).error).toBeDefined()
  })
})

describe('mergeWhoopMetrics', () => {
  it('makes a day whole from the two files it is split across', () => {
    const out = mergeWhoopMetrics(
      [parseWhoopMetricsCsv(CYCLES), parseWhoopMetricsCsv(SLEEPS)], { t: 1 })
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({
      d: '2026-08-20', recovery: 67, hrv: 43.2, strain: 12.4, sleepPerf: 88, sleepDur: 452, src: 'Whoop',
    })
  })

  it('sorts ascending by date', () => {
    const out = mergeWhoopMetrics([parseWhoopMetricsCsv(CYCLES)], { t: 1 })
    expect(out.map(m => m.d)).toEqual(['2026-08-20', '2026-08-21', '2026-08-22'])
  })

  it('is order-independent — a zip may list its entries either way', () => {
    const a = mergeWhoopMetrics([parseWhoopMetricsCsv(CYCLES), parseWhoopMetricsCsv(SLEEPS)], { t: 1 })
    const b = mergeWhoopMetrics([parseWhoopMetricsCsv(SLEEPS), parseWhoopMetricsCsv(CYCLES)], { t: 1 })
    expect(a).toEqual(b)
  })

  it('ignores files that failed to parse', () => {
    const out = mergeWhoopMetrics(
      [{ error: 'unrecognised' }, null, parseWhoopMetricsCsv(CYCLES)], { t: 1 })
    expect(out).toHaveLength(3)
  })

  it('returns empty when nothing parsed', () => {
    expect(mergeWhoopMetrics([{ error: 'empty' }], { t: 1 })).toEqual([])
    expect(mergeWhoopMetrics([], { t: 1 })).toEqual([])
  })
})

describe('mergeIntoMetrics', () => {
  const incoming = mergeWhoopMetrics([parseWhoopMetricsCsv(CYCLES)], { t: 1 })

  it('adds days the profile does not have', () => {
    const r = mergeIntoMetrics([], incoming)
    expect(r.added).toBe(3)
    expect(r.kept).toBe(0)
    expect(r.metrics).toHaveLength(3)
  })

  it('leaves an existing day alone, so re-importing is harmless', () => {
    const existing = [{ d: '2026-08-20', recovery: 99, src: 'manual' }]
    const r = mergeIntoMetrics(existing, incoming)
    expect(r.added).toBe(2)
    expect(r.kept).toBe(1)
    expect(r.metrics.find(m => m.d === '2026-08-20').recovery).toBe(99)
  })

  it('keeps the result sorted after a merge', () => {
    const existing = [{ d: '2026-09-01', recovery: 70 }, { d: '2026-01-01', recovery: 60 }]
    const r = mergeIntoMetrics(existing, incoming)
    expect(r.metrics.map(m => m.d)).toEqual([...r.metrics.map(m => m.d)].sort())
  })

  it('survives a missing or empty existing series', () => {
    expect(mergeIntoMetrics(null, incoming).added).toBe(3)
    expect(mergeIntoMetrics([], null).metrics).toEqual([])
  })
})

describe('isWhoopMetrics', () => {
  it('recognises both physiological exports', () => {
    expect(isWhoopMetrics(CYCLES_HEADER.split(','))).toBe(true)
    expect(isWhoopMetrics(SLEEPS_HEADER.split(','))).toBe(true)
  })
  it('does not claim a workouts export or an unrelated CSV', () => {
    expect(isWhoopMetrics(['Workout start time', 'Activity name', 'Duration (min)'])).toBe(false)
    expect(isWhoopMetrics(['Date', 'Exercise', 'Weight', 'Reps'])).toBe(false)
    expect(isWhoopMetrics([])).toBe(false)
  })
})

/* The verbatim physiological_cycles.csv header, cross-corroborated from a real Feb-2024
   export and from an independent importer's alias lists. Testing against the actual header
   rather than an invented one is the difference between proving this reads Whoop's files and
   proving it reads mine. */
const REAL_CYCLES_HEADER =
  'Cycle start time,Cycle end time,Cycle timezone,Recovery score %,Resting heart rate (bpm),' +
  'Heart rate variability (ms),Skin temp (celsius),Blood oxygen %,Day Strain,Energy burned (cal),' +
  'Max HR (bpm),Average HR (bpm),Sleep onset,Wake onset,Sleep performance %,Respiratory rate (rpm),' +
  'Asleep duration (min),In bed duration (min),Light sleep duration (min),Deep (SWS) duration (min),' +
  'REM duration (min),Awake duration (min),Sleep need (min),Sleep debt (min),Sleep efficiency %,' +
  'Sleep consistency %'

// Onset before midnight, wake after — the case where the two dating choices disagree.
const REAL_ROW =
  '2024-02-08 23:30:00,2024-02-09 23:12:00,UTC-05:00,64,52,44.1,33.7,96,10.0,2450,' +
  '171,68,2024-02-08 23:30:00,2024-02-09 07:12:00,66,15.1,' +
  '395,462,136,115,144,67,594,199,85,74'

describe('the real export header', () => {
  it('reads every metric out of Whoop’s actual column names', () => {
    const r = parseWhoopMetricsCsv(csv(REAL_CYCLES_HEADER, REAL_ROW))
    expect(r.error).toBeUndefined()
    const day = r.rows.get('2024-02-09')
    expect(day).toMatchObject({
      recovery: 64, rhr: 52, hrv: 44.1, skinTemp: 33.7, spo2: 96, strain: 10,
      maxHr: 171, avgHr: 68, sleepPerf: 66, respRate: 15.1,
      sleepDur: 395, inBed: 462, light: 136, deep: 115, rem: 144, awake: 67,
      sleepNeed: 594, sleepDebt: 199, sleepEff: 85, sleepCons: 74,
    })
  })

  it('dates the night by when you woke, not when you fell asleep', () => {
    // The cycle starts at 23:30 on the 8th and ends on the 9th. Dating by Cycle start time
    // files this night's recovery a day early — wrong for nearly every row, and invisible
    // unless you go looking for it.
    const r = parseWhoopMetricsCsv(csv(REAL_CYCLES_HEADER, REAL_ROW))
    expect(r.rows.has('2024-02-09')).toBe(true)
    expect(r.rows.has('2024-02-08')).toBe(false)
  })

  it('falls back to cycle start when there is no wake column', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Cycle start time,Recovery score %', '2024-02-08 23:30:00,64'))
    expect(r.rows.has('2024-02-08')).toBe(true)
  })

  it('keeps the sleep arithmetic self-consistent', () => {
    // Light + Deep + REM = Asleep, and Asleep + Awake = In bed. If a column were mismatched
    // these identities break, so asserting them checks the mapping rather than the values.
    const day = parseWhoopMetricsCsv(csv(REAL_CYCLES_HEADER, REAL_ROW)).rows.get('2024-02-09')
    expect(day.light + day.deep + day.rem).toBe(day.sleepDur)
    expect(day.sleepDur + day.awake).toBe(day.inBed)
  })
})

describe('energy units', () => {
  it('reads calories when the header says calories', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Wake onset,Energy burned (cal)', '2024-02-09 07:12:00,2450'))
    expect(r.rows.get('2024-02-09').kcal).toBe(2450)
  })

  it('converts kilojoules rather than reading them as calories', () => {
    // 8368 kJ is 2000 kcal, and 8368 is a perfectly plausible-looking calorie count. Only
    // the header can tell them apart.
    const r = parseWhoopMetricsCsv(csv(
      'Wake onset,Energy burned (kJ)', '2024-02-09 07:12:00,8368'))
    expect(r.rows.get('2024-02-09').kcal).toBeCloseTo(2000, 0)
  })

  it('drops an energy column whose header carries no unit', () => {
    // A missing calorie figure is honest; a wrong one is not. Guessing from magnitude is the
    // shortcut that rewrites a genuine 4,500 kcal day as 1,076.
    const r = parseWhoopMetricsCsv(csv(
      'Wake onset,Recovery score %,Energy burned', '2024-02-09 07:12:00,64,2450'))
    expect(r.found).toContain('recovery')
    expect(r.rows.get('2024-02-09').kcal).toBeUndefined()
  })
})

describe('naps', () => {
  it('skips a row the file marks as a nap', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Wake onset,Asleep duration (min),Nap',
      '2024-02-09 07:12:00,441,false',
      '2024-02-09 14:40:00,26,true'))
    expect(r.rows.get('2024-02-09').sleepDur).toBe(441)
    expect(r.naps).toBe(1)
  })

  it('is not fooled by the nap being listed first', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Wake onset,Asleep duration (min),Nap',
      '2024-02-09 14:40:00,26,true',
      '2024-02-09 07:12:00,441,false'))
    expect(r.rows.get('2024-02-09').sleepDur).toBe(441)
  })

  it('accepts the boolean spellings an export might use', () => {
    const r = parseWhoopMetricsCsv(csv(
      'Wake onset,Asleep duration (min),Nap',
      '2024-02-09 07:12:00,441,False',
      '2024-02-09 14:40:00,26,TRUE',
      '2024-02-10 07:00:00,30,yes'))
    expect(r.naps).toBe(2)
    expect(r.rows.has('2024-02-10')).toBe(false)
  })
})

describe('METRICS table', () => {
  it('gives every metric a range that could refuse something', () => {
    for (const [k, spec] of Object.entries(METRICS)) {
      expect(spec.cols.length, k).toBeGreaterThan(0)
      expect(spec.range[1], k).toBeGreaterThan(spec.range[0])
    }
  })
  it('puts the specific strain phrasing before the generic one', () => {
    // Order is load-bearing: a bare "strain" first would match Activity Strain.
    expect(METRICS.strain.cols[0]).toBe('day strain')
  })
})

describe('diagnoseHeader', () => {
  it('reports what a real header resolved to', () => {
    const d = diagnoseHeader(REAL_CYCLES_HEADER.split(','))
    expect(d.date).toBe('Wake onset')
    expect(d.matched.map(m => m.key)).toContain('recovery')
    expect(d.matched.find(m => m.key === 'hrv').column).toBe('Heart rate variability (ms)')
    expect(d.matched.find(m => m.key === 'strain').column).toBe('Day Strain')
  })

  it('names the columns nothing claimed, which is where a missing metric hides', () => {
    const d = diagnoseHeader(['Wake onset', 'Recovery score %', 'Some New Whoop Column'])
    expect(d.unmatched).toEqual(['Some New Whoop Column'])
  })

  it('shows an unrecognised file resolving to nothing, so the user can tell the two faults apart', () => {
    // A Whoop variant this importer has not met and a file that was never a Whoop export look
    // identical from outside. Only one is worth reporting, so the diagnosis has to separate them.
    const d = diagnoseHeader(['Date', 'Exercise', 'Weight', 'Reps'])
    expect(d.matched).toEqual([])
    expect(d.date).toBe('Date')      // matched as a date, but nothing physiological did
  })

  it('picks up energy through its unit-bearing header', () => {
    expect(diagnoseHeader(['Wake onset', 'Energy burned (kJ)']).matched.map(m => m.key)).toContain('kcal')
  })

  it('does not double-count a column', () => {
    const d = diagnoseHeader(REAL_CYCLES_HEADER.split(','))
    const cols = d.matched.map(m => m.column)
    expect(new Set(cols).size).toBe(cols.length)
    expect(d.unmatched).not.toContain(d.date)
  })

  it('survives junk', () => {
    for (const h of [null, undefined, [], ['']]) {
      expect(() => diagnoseHeader(h)).not.toThrow()
      expect(diagnoseHeader(h).matched).toEqual([])
    }
  })
})
