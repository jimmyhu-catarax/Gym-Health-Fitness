import { describe, it, expect } from 'vitest'
import { parseWhoopMetricsCsv, mergeWhoopMetrics, mergeIntoMetrics } from './whoop-metrics.js'
import { withComputedRecovery } from './physiology.js'
import { metricsSummary, seriesOf } from './metrics.js'

/* Every other fixture in this suite is 40-odd days, because that is enough to exercise the
   logic. A real Whoop account is years. These check the difference does not matter — the
   40-day fixtures cannot see a quadratic, and `withComputedRecovery` had one: a findIndex per
   day inside a per-day loop, invisible at 40 days and 79 ms at six years. */

const DAY = 86400000
const YEARS_3 = 1100

const HEADER =
  'Wake onset,Recovery score %,Heart rate variability (ms),Resting heart rate (bpm),Day Strain,' +
  'Asleep duration (min),In bed duration (min),REM duration (min),Deep (SWS) duration (min),' +
  'Light sleep duration (min),Awake duration (min),Sleep performance %'

function bigCsv(days, { from = 0 } = {}) {
  const rows = [HEADER]
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(2020, 0, 1) + (from + days - 1 - i) * DAY)
    const w = Math.sin(i / 7) * 0.5 + Math.sin(i / 23) * 0.5
    const light = Math.round(215 + w * 25), deep = Math.round(96 + w * 18), rem = Math.round(112 + w * 20)
    const asleep = light + deep + rem, awake = Math.round(38 - w * 8)
    rows.push([
      d.toISOString().slice(0, 19).replace('T', ' '),
      Math.round(62 + w * 22), Math.round((46 + w * 12) * 10) / 10, Math.round(53 - w * 4),
      Math.round((11 + w * 5) * 10) / 10,
      asleep, asleep + awake, rem, deep, light, awake, Math.round(88 + w * 8),
    ].join(','))
  }
  return rows.join('\n') + '\n'
}

describe('three years of history', () => {
  const parsed = parseWhoopMetricsCsv(bigCsv(YEARS_3))
  const merged = mergeWhoopMetrics([parsed], { t: 1 })

  it('parses every day without dropping any', () => {
    expect(parsed.error).toBeUndefined()
    expect(parsed.rows.size).toBe(YEARS_3)
    expect(merged).toHaveLength(YEARS_3)
  })

  it('stays sorted, with no duplicate dates', () => {
    const dates = merged.map(m => m.d)
    expect(dates).toEqual([...dates].sort())
    expect(new Set(dates).size).toBe(YEARS_3)
  })

  it('keeps the sleep arithmetic intact across the whole span', () => {
    // A rounding or accumulation fault would show up somewhere in 1,100 rows, not in 40.
    for (const m of merged) expect(m.light + m.deep + m.rem).toBe(m.sleepDur)
  })

  it('summarises without choking', () => {
    const s = metricsSummary({ metrics: merged }, { now: Date.parse('2023-02-01T12:00:00Z') })
    expect(s.ok).toBe(true)
    expect(s.recovery).not.toBeNull()
    // The window is honoured rather than the whole series being plotted.
    expect(seriesOf(merged, 'recovery', { days: 30, now: Date.parse('2023-02-01T12:00:00Z') }).length)
      .toBeLessThanOrEqual(31)
  })

  it('bounds each day’s baseline to the window, which is what makes it linear', () => {
    // The real property, and the one that makes series length irrelevant: a day's recovery
    // depends only on the 28 days before it. So the same day scored inside 1,100 days of
    // history must come out identical to that day scored inside a 29-day slice ending on it.
    // If anything ever widens the baseline to the whole series, this breaks — and that is
    // exactly the change that would reintroduce quadratic cost.
    const i = 600
    const full = withComputedRecovery(merged)
    const slice = withComputedRecovery(merged.slice(i - 28, i + 1))
    expect(slice).toHaveLength(29)
    expect(slice[28].d).toBe(full[i].d)
    expect(slice[28].recovery).toBe(full[i].recovery)
    expect(full[i].recovery).toBeGreaterThan(0)
  })

  it('re-importing three years adds nothing and keeps every day', () => {
    const first = mergeIntoMetrics([], merged)
    expect(first.added).toBe(YEARS_3)
    const again = mergeIntoMetrics(first.metrics, merged)
    expect(again.added).toBe(0)
    expect(again.kept).toBe(YEARS_3)
    expect(again.metrics).toHaveLength(YEARS_3)
  })

  it('merges a later export onto an earlier one without gaps or duplicates', () => {
    // What actually happens over time: import once, train for a year, export again.
    const older = mergeWhoopMetrics([parseWhoopMetricsCsv(bigCsv(400))], { t: 1 })
    const newer = mergeWhoopMetrics([parseWhoopMetricsCsv(bigCsv(400, { from: 300 }))], { t: 2 })
    const out = mergeIntoMetrics(mergeIntoMetrics([], older).metrics, newer)
    expect(out.metrics).toHaveLength(700)          // 400 + 400 - 100 overlapping
    expect(out.kept).toBe(100)
    expect(new Set(out.metrics.map(m => m.d)).size).toBe(700)
  })
})
