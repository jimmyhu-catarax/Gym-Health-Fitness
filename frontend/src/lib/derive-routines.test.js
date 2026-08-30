import { describe, it, expect } from 'vitest'
import { deriveRoutines, isGenericName, glyphFor, median } from './derive-routines.js'

// One session: entries in the given order, `sets` working sets of `reps` each.
const day = (id, name, spec) => ({
  id, d: '2025-01-' + String(id).padStart(2, '0'), name,
  entries: spec.map(([ex, sets, reps, wu = 0]) => ({
    id: ex,
    sets: [
      ...Array.from({ length: wu }, () => ({ w: 20, r: 10, done: true, wu: 1 })),
      ...Array.from({ length: sets }, () => ({ w: 60, r: reps, done: true })),
    ],
  })),
})

const PUSH = [['bench', 4, 8], ['ohp', 3, 10], ['fly', 3, 12]]
const pushDays = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => day(from + i, 'Push Day', PUSH))

describe('median', () => {
  it('takes the middle, and the mean of the two middles when even', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('ignores non-numbers and survives an empty list', () => {
    expect(median([])).toBe(0)
    expect(median([1, undefined, NaN, 3])).toBe(2)
  })
  it('is not moved by one outlier session', () => {
    expect(median([3, 3, 3, 3, 20])).toBe(3)
  })
})

describe('isGenericName', () => {
  it('refuses Hevys time-of-day auto-titles', () => {
    // The whole reason this guard exists: a user who never named a workout gets one of
    // these on every session, across every split they train.
    for (const n of ['Morning Workout', 'Afternoon Workout', 'Evening Workout', 'Night Workout', 'Late Night Workout'])
      expect(isGenericName(n)).toBe(true)
  })
  it('refuses placeholders, dates and nothing at all', () => {
    for (const n of ['Imported', 'workout', 'Untitled', '', null, '2025-01-04', '12/03/24'])
      expect(isGenericName(n)).toBe(true)
  })
  it('accepts a name somebody chose', () => {
    for (const n of ['Push Day', 'Upper A', 'Leg Day', 'PPL — Pull', '5/3/1 Squat'])
      expect(isGenericName(n)).toBe(false)
  })
})

describe('glyphFor', () => {
  it('reads the split out of the title', () => {
    expect(glyphFor('Leg Day')).toBe('legs')
    expect(glyphFor('Pull A')).toBe('pullup')
    expect(glyphFor('Push B')).toBe('figureStrength')
    expect(glyphFor('Arm Day')).toBe('arm')
  })
  it('falls back rather than guessing', () => {
    expect(glyphFor('Week 3 Block B')).toBe('figureStrength')  // nothing matches; DEFAULT_GLYPH
  })
})

describe('deriveRoutines', () => {
  it('rebuilds a routine from repeated sessions under one title', () => {
    const { routines } = deriveRoutines(pushDays(5))
    expect(routines).toHaveLength(1)
    const r = routines[0]
    expect(r.name).toBe('Push Day')
    expect(r.sessions).toBe(5)
    expect(r.ex.map(e => e.id)).toEqual(['bench', 'ohp', 'fly'])
    expect(r.ex[0]).toMatchObject({ id: 'bench', sets: 4, reps: 8, weight: 0 })
  })

  it('links every session in the group to the routine it built', () => {
    const ws = pushDays(4)
    const { routines, links } = deriveRoutines(ws)
    for (const w of ws) expect(links[w.id]).toBe(routines[0].id)
  })

  it('keeps a lift you usually do and drops one you did once', () => {
    const ws = [
      ...pushDays(4),
      day(9, 'Push Day', [...PUSH, ['dip', 3, 8]]),
    ]
    const { routines } = deriveRoutines(ws)
    expect(routines[0].ex.map(e => e.id)).toEqual(['bench', 'ohp', 'fly'])
  })

  it('counts working sets, not warm-ups', () => {
    // Four working sets behind two ramp-up sets is a routine of four, not six. Warm-ups
    // are marked by the file; if nothing is marked, every set counts.
    const ws = Array.from({ length: 4 }, (_, i) => day(i + 1, 'Push Day', [['bench', 4, 8, 2], ['ohp', 3, 10]]))
    const { routines } = deriveRoutines(ws)
    expect(routines[0].ex[0].sets).toBe(4)
  })

  it('orders the routine the way the sessions ran, not by how often each lift appears', () => {
    const ws = Array.from({ length: 4 }, (_, i) =>
      day(i + 1, 'Pull Day', [['row', 3, 10], ['pulldown', 3, 10], ['curl', 3, 12]]))
    // curl is in every session but last; it must stay last.
    expect(deriveRoutines(ws).routines[0].ex.map(e => e.id)).toEqual(['row', 'pulldown', 'curl'])
  })

  it('refuses a title seen fewer than three times', () => {
    const { routines, skipped } = deriveRoutines(pushDays(2))
    expect(routines).toHaveLength(0)
    expect(skipped).toEqual([{ name: 'Push Day', sessions: 2, why: 'few' }])
  })

  it('refuses a catch-all title that holds three different splits', () => {
    // "Gym" on push, pull and legs: nothing clears half the sessions, so there is no
    // template to find. Guessing one would hand the progression engine a fiction.
    const ws = [
      ...Array.from({ length: 3 }, (_, i) => day(i + 1, 'Gym Sesh', PUSH)),
      ...Array.from({ length: 3 }, (_, i) => day(i + 4, 'Gym Sesh', [['row', 3, 10], ['pulldown', 3, 10], ['curl', 3, 12]])),
      ...Array.from({ length: 3 }, (_, i) => day(i + 7, 'Gym Sesh', [['squat', 4, 5], ['rdl', 3, 8], ['calf', 3, 15]])),
    ]
    const { routines, skipped } = deriveRoutines(ws)
    expect(routines).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ name: 'Gym Sesh', why: 'varied' })
  })

  it('refuses a title whose only fixed point is a shared warm-up lift', () => {
    // Every session opens on the bike and then does something different. One lift is not
    // a template — MIN_EXERCISES says so before cohesion is even measured.
    const ws = Array.from({ length: 6 }, (_, i) =>
      day(i + 1, 'Open Gym', [['bike', 1, 0], [`odd${i}`, 3, 10], [`odd${i}b`, 3, 10]]))
    const { routines, skipped } = deriveRoutines(ws)
    expect(routines).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ name: 'Open Gym', why: 'varied' })
  })

  it('refuses a title where the fixed lifts are a minority of the session', () => {
    // Two lifts every time, four that rotate: enough exercises clear MIN_SHARE to look
    // like a routine, but they are a third of what actually gets trained. This is the
    // case only MIN_COHESION catches, and the routine it would otherwise build is one
    // nobody has ever done.
    const ws = Array.from({ length: 6 }, (_, i) => day(i + 1, 'Full Body', [
      ['squat', 3, 5], ['bench', 3, 5],
      [`acc${i}a`, 3, 10], [`acc${i}b`, 3, 10], [`acc${i}c`, 3, 10], [`acc${i}d`, 3, 10],
    ]))
    const { routines, skipped } = deriveRoutines(ws)
    expect(routines).toHaveLength(0)
    expect(skipped[0]).toMatchObject({ name: 'Full Body', why: 'varied' })
    // ...and it is a near miss, not an obvious one: relax the guard and it builds.
    expect(deriveRoutines(ws, { minCohesion: 0.3 }).routines[0].ex.map(e => e.id))
      .toEqual(['squat', 'bench'])
  })

  it('refuses Hevys automatic titles and says why', () => {
    const ws = Array.from({ length: 8 }, (_, i) => day(i + 1, 'Morning Workout', PUSH))
    const { routines, skipped } = deriveRoutines(ws)
    expect(routines).toHaveLength(0)
    expect(skipped).toEqual([{ name: 'Morning Workout', sessions: 8, why: 'generic' }])
  })

  it('builds several routines from one file and puts the most-trained first', () => {
    const ws = [
      ...pushDays(3, 1),
      ...Array.from({ length: 6 }, (_, i) => day(i + 10, 'Leg Day', [['squat', 4, 5], ['rdl', 3, 8], ['calf', 3, 15]])),
    ]
    const { routines } = deriveRoutines(ws)
    expect(routines.map(r => r.name)).toEqual(['Leg Day', 'Push Day'])
    expect(routines[0].emoji).toBe('legs')
  })

  it('groups titles that differ only in case or punctuation, and keeps the commonest spelling', () => {
    const ws = [...pushDays(3, 1), day(4, 'push day', PUSH), day(5, 'PUSH-DAY', PUSH)]
    const { routines } = deriveRoutines(ws)
    expect(routines).toHaveLength(1)
    expect(routines[0].name).toBe('Push Day')
    expect(routines[0].sessions).toBe(5)
  })

  it('gives every routine its own id', () => {
    const ws = [
      ...pushDays(3, 1),
      ...Array.from({ length: 3 }, (_, i) => day(i + 10, 'Leg Day', [['squat', 4, 5], ['rdl', 3, 8]])),
    ]
    const { routines } = deriveRoutines(ws)
    expect(new Set(routines.map(r => r.id)).size).toBe(2)
  })

  it('keeps the twelve most-trained routines and unlinks the sessions of the rest', () => {
    // Somebody with a block per month can have thirty named splits. Importing all of them
    // is a plan nobody can read — but a routine that was dropped must not leave its
    // sessions pointing at an id that will never exist.
    const ws = []
    for (let r = 0; r < 15; r++) {
      // routine r was trained r + 3 times, so the last three built are the least-trained
      for (let i = 0; i < r + 3; i++) {
        ws.push(day(ws.length + 1, `Block ${String.fromCharCode(65 + r)}`,
          [[`lift${r}a`, 3, 8], [`lift${r}b`, 3, 10], [`lift${r}c`, 3, 12]]))
      }
    }
    const { routines, links, skipped } = deriveRoutines(ws)
    expect(routines).toHaveLength(12)
    expect(routines[0].name).toBe('Block O')   // trained 17 times
    expect(skipped.map(x => x.name)).toEqual(['Block C', 'Block B', 'Block A'])
    expect(skipped.every(x => x.why === 'many')).toBe(true)

    const live = new Set(routines.map(r => r.id))
    expect(Object.values(links).every(id => live.has(id))).toBe(true)
    // and the dropped ones' sessions are simply unlinked, not linked to something else
    expect(Object.keys(links)).toHaveLength(ws.length - (3 + 4 + 5))
  })

  it('returns nothing at all rather than throwing on an empty or malformed history', () => {
    for (const input of [[], null, undefined, [{ id: 'x', name: 'A' }], [null]])
      expect(deriveRoutines(input)).toEqual({ routines: [], links: {}, skipped: [] })
  })
})
