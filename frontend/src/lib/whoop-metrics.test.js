import { describe, it, expect } from 'vitest'
import {
  parseWhoopMetricsCsv, mergeWhoopMetrics, mergeIntoMetrics, isWhoopMetrics, dayOf, METRICS,
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
