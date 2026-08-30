import { describe, it, expect } from 'vitest'
import {
  setRpe, sessionRpe, sessionMinutes, sessionLoad, dailyLoad,
  MIN_MINUTES, MAX_MINUTES,
} from './session-load.js'

const NOW = Date.parse('2026-03-01T12:00:00Z')
const DAY = 86400000
const iso = back => new Date(NOW - back * DAY).toISOString().slice(0, 10)

// A session on the day `back` days ago: `mins` long, `sets` completed sets, each carrying
// `eff` (an {rpe} or {rir} or nothing) and w x r for volume.
const sess = (back, { mins = 60, sets = 10, eff = null, w = 100, r = 5, rated = null } = {}) => {
  const start = NOW - back * DAY
  const n = rated == null ? sets : rated
  return {
    id: 'w' + back, d: iso(back), start, end: start + mins * 60000,
    entries: [{
      id: 'bench',
      sets: Array.from({ length: sets }, (_, i) => ({ w, r, done: true, ...(eff && i < n ? eff : {}) })),
    }],
  }
}

describe('setRpe', () => {
  it('reads an RPE straight off the set', () => {
    expect(setRpe({ rpe: 8 })).toBe(8)
  })
  it('reads RIR from the other end of the same scale', () => {
    expect(setRpe({ rir: 2 })).toBe(8)
    expect(setRpe({ rir: 0 })).toBe(10)
  })
  it('prefers RIR where a set somehow carries both, matching how sets are read back', () => {
    expect(setRpe({ rir: 3, rpe: 6 })).toBe(7)
  })
  it('clamps to the CR-10 scale and refuses anything that is not a number', () => {
    expect(setRpe({ rir: 12 })).toBe(0)
    expect(setRpe({ rpe: 14 })).toBe(10)
    expect(setRpe({})).toBeNull()
    expect(setRpe(null)).toBeNull()
    expect(setRpe({ rpe: 'hard' })).toBeNull()
  })
})

describe('sessionRpe', () => {
  it('averages the rated sets', () => {
    const w = sess(0, { sets: 4, eff: { rpe: 8 } })
    w.entries[0].sets[0].rpe = 6
    expect(sessionRpe(w)).toBe(7.5)
  })
  it('ignores sets that were never completed', () => {
    const w = sess(0, { sets: 4, eff: { rpe: 8 } })
    w.entries[0].sets[3] = { w: 100, r: 5, done: false, rpe: 2 }
    expect(sessionRpe(w)).toBe(8)
  })
  it('refuses when one set in thirty carries a rating', () => {
    // That is a set's effort, not a session's, and Foster's number is only as good as the
    // rating under it.
    expect(sessionRpe(sess(0, { sets: 30, eff: { rpe: 9 }, rated: 1 }))).toBeNull()
  })
  it('accepts exactly half rated', () => {
    expect(sessionRpe(sess(0, { sets: 10, eff: { rpe: 8 }, rated: 5 }))).toBe(8)
  })
  it('refuses a session with nothing rated at all', () => {
    expect(sessionRpe(sess(0))).toBeNull()
    expect(sessionRpe(null)).toBeNull()
    expect(sessionRpe({ entries: [] })).toBeNull()
  })
})

describe('sessionMinutes', () => {
  it('reads the length off the clock', () => {
    expect(sessionMinutes(sess(0, { mins: 72 }))).toBe(72)
  })
  it('refuses a length no session has', () => {
    // FitNotes writes no duration, so start === end; a forgotten timer runs for days.
    expect(sessionMinutes(sess(0, { mins: 0 }))).toBeNull()
    expect(sessionMinutes(sess(0, { mins: MIN_MINUTES - 1 }))).toBeNull()
    expect(sessionMinutes(sess(0, { mins: MAX_MINUTES + 1 }))).toBeNull()
    expect(sessionMinutes({})).toBeNull()
  })
})

describe('sessionLoad', () => {
  it('is Foster: session RPE times minutes', () => {
    expect(sessionLoad(sess(0, { mins: 60, eff: { rpe: 8 } }))).toBe(480)
    expect(sessionLoad(sess(0, { mins: 45, eff: { rir: 3 } }))).toBe(315)
  })
  it('refuses when either half is missing rather than filling one in', () => {
    expect(sessionLoad(sess(0, { mins: 60 }))).toBeNull()
    expect(sessionLoad(sess(0, { mins: 0, eff: { rpe: 8 } }))).toBeNull()
  })
})

describe('dailyLoad', () => {
  const rpeWeeks = () => Array.from({ length: 20 }, (_, i) => sess(i, { mins: 60, eff: { rpe: 8 } }))

  it('uses sRPE when the history is rated', () => {
    const r = dailyLoad(rpeWeeks(), { now: NOW })
    expect(r.basis).toBe('srpe')
    expect(r.unit).toBe('AU')
    expect(r.days).toHaveLength(20)
    expect(r.days[0].load).toBe(480)
  })

  it('falls back to volume load when the effort column is off', () => {
    const r = dailyLoad(Array.from({ length: 20 }, (_, i) => sess(i, { w: 100, r: 5, sets: 10 })), { now: NOW })
    expect(r.basis).toBe('volume')
    expect(r.days[0].load).toBe(5000)
  })

  it('falls back rather than build a month out of the week somebody happened to rate', () => {
    const ws = [
      ...Array.from({ length: 4 }, (_, i) => sess(i, { eff: { rpe: 8 } })),
      ...Array.from({ length: 16 }, (_, i) => sess(i + 4)),
    ]
    const r = dailyLoad(ws, { now: NOW })
    expect(r.basis).toBe('volume')
    expect(r.rated).toBe(4)
    expect(r.sessions).toBe(20)
  })

  it('picks the basis from the recent window but builds the series over everything', () => {
    // Effort was switched on a fortnight ago. The basis follows the recent window; the
    // older sessions still contribute, on that basis, so a chronic baseline can reach back.
    const ws = [
      ...Array.from({ length: 14 }, (_, i) => sess(i, { eff: { rpe: 8 } })),
      ...Array.from({ length: 30 }, (_, i) => sess(i + 30)),
    ]
    const r = dailyLoad(ws, { now: NOW })
    expect(r.basis).toBe('srpe')
    // ...and the unrated older sessions are absent rather than counted as zero-effort days
    expect(r.days).toHaveLength(14)
  })

  it('sums two sessions logged on one day', () => {
    const a = sess(1, { mins: 60, eff: { rpe: 8 } })
    const b = { ...sess(1, { mins: 30, eff: { rpe: 6 } }), id: 'b' }
    const r = dailyLoad([a, b], { now: NOW })
    expect(r.days).toEqual([{ d: iso(1), load: 660 }])
  })

  it('leaves a bodyweight day out of a volume series instead of scoring it a rest day', () => {
    // Volume load is blind to bodyweight work. Counting the session as zero would drag the
    // baseline down and read as a day off.
    const ws = [
      ...Array.from({ length: 10 }, (_, i) => sess(i, { w: 100, r: 5 })),
      sess(11, { w: 0, r: 12 }),
    ]
    const r = dailyLoad(ws, { now: NOW })
    expect(r.basis).toBe('volume')
    expect(r.days.map(x => x.d)).not.toContain(iso(11))
  })

  it('has no basis at all when there is nothing to measure', () => {
    expect(dailyLoad([], { now: NOW })).toMatchObject({ basis: null, days: [] })
    expect(dailyLoad(null, { now: NOW })).toMatchObject({ basis: null, days: [] })
    expect(dailyLoad([{ d: '2026-02-01' }], { now: NOW })).toMatchObject({ basis: null, days: [] })
  })
})
