import { describe, it, expect } from 'vitest'
import { parseWorkoutCSV, mergeImport } from './import-csv.js'

// A Hevy export, trimmed to the columns this path reads. The real file has fourteen.
const HEVY = 'title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps'

// One Hevy session: `d` is a day in Jan 2026, `spec` is [exercise, setCount, reps, warmups].
const session = (title, d, spec) => {
  const at = `"${String(d).padStart(2, '0')} Jan 2026, 18:00"`
  const end = `"${String(d).padStart(2, '0')} Jan 2026, 19:00"`
  const out = []
  for (const [ex, sets, reps, wu = 0] of spec) {
    let i = 0
    for (; i < wu; i++) out.push(`${title},${at},${end},${ex},${i},warmup,20,${reps}`)
    for (let k = 0; k < sets; k++, i++) out.push(`${title},${at},${end},${ex},${i},normal,60,${reps}`)
  }
  return out
}

const PUSH = [['Bench Press (Barbell)', 4, 8], ['Overhead Press (Barbell)', 3, 10], ['Triceps Pushdown', 3, 12]]
const PULL = [['Deadlift (Barbell)', 3, 5], ['Bent Over Row (Barbell)', 4, 8], ['Bicep Curl (Dumbbell)', 3, 12]]

const file = (...lines) => parseWorkoutCSV([HEVY, ...lines].join('\n'), { unit: 'kg' })

const state = over => ({ workouts: [], routines: [], customEx: [], bodyweight: [], exWeights: {}, ...over })

describe('rebuilding routines from a Hevy export', () => {
  it('turns a repeated split into a routine and hangs its sessions on it', () => {
    const p = file(
      ...session('Push Day', 5, PUSH),
      ...session('Push Day', 7, PUSH),
      ...session('Push Day', 9, PUSH),
    )
    expect(p.error).toBeUndefined()
    expect(p.routines).toHaveLength(1)

    const r = p.routines[0]
    expect(r.name).toBe('Push Day')
    expect(r.sessions).toBe(3)
    expect(r.ex).toHaveLength(3)
    // Matched against the library, so the routine points at real exercise ids and not at
    // the strings Hevy wrote.
    expect(r.ex[0].id).toBe('0025')
    expect(r.ex[0]).toMatchObject({ sets: 4, reps: 8, weight: 0 })
    // Every session links to it, which is what makes the history read back as this routine.
    expect(p.workouts.map(w => w.routineId)).toEqual([r.id, r.id, r.id])
  })

  it('does not count Hevys warm-up sets towards the prescription', () => {
    const withWarmups = [['Bench Press (Barbell)', 4, 8, 2], ['Overhead Press (Barbell)', 3, 10, 1], ['Triceps Pushdown', 3, 12]]
    const p = file(
      ...session('Push Day', 5, withWarmups),
      ...session('Push Day', 7, withWarmups),
      ...session('Push Day', 9, withWarmups),
    )
    expect(p.routines[0].ex.map(e => e.sets)).toEqual([4, 3, 3])
    expect(p.warmups).toBe(9)
  })

  it('builds one routine per split in the same file', () => {
    const p = file(
      ...session('Push Day', 5, PUSH), ...session('Pull Day', 6, PULL),
      ...session('Push Day', 8, PUSH), ...session('Pull Day', 9, PULL),
      ...session('Push Day', 11, PUSH), ...session('Pull Day', 12, PULL),
    )
    expect(p.routines.map(r => r.name).sort()).toEqual(['Pull Day', 'Push Day'])
    expect(p.routines.map(r => r.emoji).sort()).toEqual(['figureStrength', 'pullup'])
  })

  it('rebuilds nothing from a file whose workouts were never named', () => {
    // Hevy titles an unnamed session by the time of day. Reading those as routines would
    // fold every split someone trains into one, so they are refused and reported.
    const p = file(
      ...session('Morning Workout', 5, PUSH),
      ...session('Morning Workout', 7, PULL),
      ...session('Morning Workout', 9, PUSH),
    )
    expect(p.routines).toEqual([])
    expect(p.skippedRoutines).toEqual([{ name: 'Morning Workout', sessions: 3, why: 'generic' }])
    expect(p.workouts.every(w => w.routineId === null)).toBe(true)
    // ...and the history itself still imports in full.
    expect(p.workouts).toHaveLength(3)
    expect(p.sets).toBe(30)
  })

  it('rebuilds nothing from a FitNotes file, which has no workout titles at all', () => {
    const p = parseWorkoutCSV([
      'Date,Exercise,Category,Weight,Reps',
      '2026-01-05,Bench Press,Chest,60,8',
      '2026-01-05,Overhead Press,Shoulders,40,10',
    ].join('\n'), { unit: 'kg' })
    expect(p.error).toBeUndefined()
    expect(p.workouts).toHaveLength(1)
    expect(p.routines).toEqual([])
  })
})

describe('merging rebuilt routines into a profile', () => {
  const threePush = () => file(...session('Push Day', 5, PUSH), ...session('Push Day', 7, PUSH), ...session('Push Day', 9, PUSH))

  it('adds the routine and reports how many it added', () => {
    const S = state()
    const p = threePush()
    const res = mergeImport(S, p)
    expect(res).toMatchObject({ added: 3, routines: 1 })
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0].name).toBe('Push Day')
    // Derivation evidence is for the confirm sheet; it does not belong in synced state.
    expect(S.routines[0].sessions).toBeUndefined()
  })

  it('does not grow a second copy of the plan when the same file is imported twice', () => {
    const S = state()
    mergeImport(S, threePush())
    const res = mergeImport(S, threePush())
    expect(res).toMatchObject({ added: 0, routines: 0 })
    expect(S.routines).toHaveLength(1)
  })

  it('hands sessions to a routine the profile already has under that name', () => {
    const S = state({ routines: [{ id: 'mine', name: 'push day', emoji: 'arm', ex: [] }] })
    mergeImport(S, threePush())
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0].id).toBe('mine')
    expect(S.workouts.every(w => w.routineId === 'mine')).toBe(true)
  })

  it('leaves the routine out when every session it was built from is already here', () => {
    // The days are present but the routine is not — an older import, before this existed.
    // Adding a routine no *new* session points at would seed the plan from nothing.
    const p = threePush()
    const S = state({ workouts: p.workouts.map(w => ({ ...w, routineId: null })) })
    const res = mergeImport(S, threePush())
    expect(res).toMatchObject({ added: 0, routines: 0 })
    expect(S.routines).toEqual([])
  })
})
