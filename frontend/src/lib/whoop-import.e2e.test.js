// End to end: the bytes of a Whoop export, through unzip, through the archive router, to the
// shape the confirm sheet renders and the store keeps.
//
// The unit tests feed CSV *text* to the parser. This feeds a real ZIP, because everything
// between the file and the parser is where an import actually breaks in the wild: the archive
// reader, the file-name routing, the sniffing fallback, the merge across two files. A parser
// that is perfect on a string it was handed is not the same as an import that works on the
// thing a person downloads.
//
// The headers are the verbatim ones Whoop writes, cross-corroborated from a real export and
// from an independent importer's alias lists. See issue #12.

import { describe, it, expect } from 'vitest'
import { deflateRawSync, crc32 } from 'node:zlib'
import { unzip } from './unzip.js'
import { parseArchive } from './import-health.js'
import { mergeIntoMetrics } from './whoop-metrics.js'

/* A real archive, written here rather than recorded as base64, so the fixture is readable
   and a reader can see exactly what the importer is being asked to survive. */
const LOC = 0x04034b50, CDH = 0x02014b50, EOCD = 0x06054b50
function zip(files) {
  const enc = new TextEncoder()
  const parts = [], central = []
  let offset = 0
  for (const { name, body } of files) {
    const nameB = enc.encode(name)
    const raw = enc.encode(body)
    const data = new Uint8Array(deflateRawSync(Buffer.from(raw)))
    const sum = crc32 ? crc32(Buffer.from(raw)) : 0
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, LOC, true); lh.setUint16(4, 20, true); lh.setUint16(8, 8, true)
    lh.setUint32(14, sum, true)
    lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true)
    lh.setUint16(26, nameB.length, true)
    parts.push(new Uint8Array(lh.buffer), nameB, data)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, CDH, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true)
    ch.setUint16(10, 8, true); ch.setUint32(16, sum, true)
    ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true)
    ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true)
    central.push(new Uint8Array(ch.buffer), nameB)
    offset += 30 + nameB.length + data.length
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0)
  const eo = new DataView(new ArrayBuffer(22))
  eo.setUint32(0, EOCD, true)
  eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true)
  eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(eo.buffer)]
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0))
  let at = 0
  for (const b of all) { out.set(b, at); at += b.length }
  return out
}

/* Verbatim Whoop headers. */
const CYCLES_H = 'Cycle start time,Cycle end time,Cycle timezone,Recovery score %,' +
  'Resting heart rate (bpm),Heart rate variability (ms),Skin temp (celsius),Blood oxygen %,' +
  'Day Strain,Energy burned (cal),Max HR (bpm),Average HR (bpm),Sleep onset,Wake onset,' +
  'Sleep performance %,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),' +
  'Light sleep duration (min),Deep (SWS) duration (min),REM duration (min),Awake duration (min),' +
  'Sleep need (min),Sleep debt (min),Sleep efficiency %,Sleep consistency %'
const SLEEPS_H = 'Cycle start time,Cycle end time,Cycle timezone,Sleep onset,Wake onset,' +
  'Sleep performance %,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),' +
  'Light sleep duration (min),Deep (SWS) duration (min),REM duration (min),Awake duration (min),' +
  'Sleep need (min),Sleep debt (min),Sleep efficiency %,Sleep consistency %,Nap'
const WORKOUTS_H = 'Cycle start time,Cycle end time,Cycle timezone,Workout start time,' +
  'Workout end time,Duration (min),Activity name,Activity Strain,Energy burned (cal),' +
  'Max HR (bpm),Average HR (bpm),HR Zone 1 %,HR Zone 2 %,HR Zone 3 %,HR Zone 4 %,HR Zone 5 %,' +
  'GPS enabled,Distance (meters),Altitude gain (meters),Altitude change (meters)'
const JOURNAL_H = 'Cycle start time,Cycle end time,Cycle timezone,Question text,Answered yes,Notes'

/* Two nights. Both fall asleep before midnight, so cycle-start dating and wake dating
   disagree — the case that must come out right. Stage sums are internally consistent. */
const cyclesRow = (sleepD, wakeD, rec) =>
  `${sleepD} 23:30:00,${wakeD} 23:12:00,UTC-05:00,${rec},52,44.1,33.7,96,10.0,2450,` +
  `171,68,${sleepD} 23:30:00,${wakeD} 07:12:00,66,15.1,395,462,136,115,144,67,594,199,85,74`
const sleepsRow = (sleepD, wakeD, nap) =>
  `${sleepD} 23:30:00,${wakeD} 23:12:00,UTC-05:00,${sleepD} 23:30:00,${wakeD} 07:12:00,` +
  `66,15.1,395,462,136,115,144,67,594,199,85,74,${nap}`

const EXPORT = () => zip([
  { name: 'my_whoop_data_2026/physiological_cycles.csv',
    body: [CYCLES_H, cyclesRow('2026-02-08', '2026-02-09', 64), cyclesRow('2026-02-09', '2026-02-10', 78)].join('\n') + '\n' },
  { name: 'my_whoop_data_2026/sleeps.csv',
    body: [SLEEPS_H, sleepsRow('2026-02-08', '2026-02-09', 'false'),
      sleepsRow('2026-02-09', '2026-02-10', 'false'),
      // an afternoon nap on the 9th — must not displace that night
      '2026-02-09 14:00:00,2026-02-09 14:26:00,UTC-05:00,2026-02-09 14:00:00,2026-02-09 14:26:00,' +
      '10,15.0,26,28,20,3,3,2,594,199,92,74,true'].join('\n') + '\n' },
  { name: 'my_whoop_data_2026/workouts.csv',
    body: [WORKOUTS_H,
      '2026-02-08 23:30:00,2026-02-09 23:12:00,UTC-05:00,2026-02-09 06:30:00,2026-02-09 07:14:00,' +
      '44,Running,11.2,512,178,148,10,20,30,25,15,true,8200,40,0'].join('\n') + '\n' },
  { name: 'my_whoop_data_2026/journal_entries.csv',
    body: [JOURNAL_H, '2026-02-08 23:30:00,2026-02-09 23:12:00,UTC-05:00,Caffeine,true,'].join('\n') + '\n' },
  // Archives made on a Mac carry these; they must not be mistaken for data.
  { name: '__MACOSX/._sleeps.csv', body: 'Mac OS X resource fork garbage' },
])

describe('a whole Whoop export, from bytes', () => {
  it('unzips to the four files Whoop writes', async () => {
    const entries = await unzip(EXPORT())
    expect(entries.map(e => e.name.split('/').pop()).sort())
      .toEqual(['._sleeps.csv', 'journal_entries.csv', 'physiological_cycles.csv', 'sleeps.csv', 'workouts.csv'])
  })

  it('routes to workouts and carries the physiology along', async () => {
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    expect(out.source).toBe('Whoop')
    expect(out.workouts).toHaveLength(1)
    expect(out.metrics).toHaveLength(2)
  })

  it('dates both nights by when the sleeper woke, not when the cycle began', async () => {
    // Both cycles start at 23:30 the evening before. Cycle-start dating would file these as
    // the 8th and 9th; the days they actually describe are the 9th and 10th.
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    expect(out.metrics.map(m => m.d)).toEqual(['2026-02-09', '2026-02-10'])
  })

  it('reads a full day across both physiology files', async () => {
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    expect(out.metrics[0]).toMatchObject({
      d: '2026-02-09', recovery: 64, rhr: 52, hrv: 44.1, strain: 10, kcal: 2450,
      maxHr: 171, avgHr: 68, sleepDur: 395, inBed: 462, light: 136, deep: 115, rem: 144,
      awake: 67, sleepPerf: 66, sleepEff: 85, respRate: 15.1, src: 'Whoop',
    })
  })

  it('keeps the sleep arithmetic intact through the whole pipeline', async () => {
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    for (const m of out.metrics) {
      expect(m.light + m.deep + m.rem).toBe(m.sleepDur)
      expect(m.sleepDur + m.awake).toBe(m.inBed)
    }
  })

  it('does not let the nap displace the night it shares a date with', async () => {
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    const feb10 = out.metrics.find(m => m.d === '2026-02-10')
    expect(feb10.sleepDur).toBe(395)
  })

  it('turns the workout into a cardio session', async () => {
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    const w = out.workouts[0]
    expect(w.d).toBe('2026-02-09')
    expect(w.entries[0].sets[0].min).toBe(44)
    // 8.2 km in 44 minutes is about 11.2 km/h.
    expect(w.entries[0].sets[0].speed).toBeCloseTo(11.2, 0)
  })

  it('merges into a profile and is idempotent on a second import', async () => {
    // The whole point of day-level dedup: someone will import January's export after
    // February's, and it must not overwrite good days with a partial re-read.
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    const first = mergeIntoMetrics([], out.metrics)
    expect(first.added).toBe(2)
    const second = mergeIntoMetrics(first.metrics, out.metrics)
    expect(second.added).toBe(0)
    expect(second.kept).toBe(2)
    expect(second.metrics).toEqual(first.metrics)
  })

  it('does not read the journal or the Mac resource fork as physiology', async () => {
    const out = await parseArchive(await unzip(EXPORT()), { unit: 'kg' })
    // Two days, from the two real physiology files. Nothing from journal_entries.csv, which
    // has a Cycle start time and would otherwise look date-shaped to a sloppier router.
    expect(out.metrics).toHaveLength(2)
    expect(out.metrics.every(m => m.recovery != null || m.sleepDur != null)).toBe(true)
  })

  it('still works when the export holds only physiology', async () => {
    const partial = zip([
      { name: 'my_whoop_data_2026/physiological_cycles.csv',
        body: [CYCLES_H, cyclesRow('2026-02-08', '2026-02-09', 64)].join('\n') + '\n' },
    ])
    const out = await parseArchive(await unzip(partial), { unit: 'kg' })
    expect(out.kind).toBe('metrics')
    expect(out.days).toBe(1)
    expect(out.from).toBe('2026-02-09')
    expect(out.fields).toContain('recovery')
  })
})
