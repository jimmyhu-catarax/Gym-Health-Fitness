import { describe, it, expect } from 'vitest'
import { mapRoutine, mapRoutines, applyRealRoutines, repsOf } from './hevy-routines.js'
import { fetchRoutines, syncHevy } from './hevy-api.js'
import { mergeImport } from './import-csv.js'

/* Shapes below follow Hevy's published OpenAPI document for GET /v1/routines: a routine has
   {id, title, folder_id, exercises:[{index, title, rest_seconds, notes, exercise_template_id,
   supersets_id, sets:[{index, type, weight_kg, reps, rep_range, ...}]}]}. */

const set = (o = {}) => ({ index: 0, type: 'normal', weight_kg: 100, reps: 10, ...o })
const exercise = (title, sets, o = {}) => ({
  index: 0, title, rest_seconds: 60, notes: '', exercise_template_id: '05293BCA',
  supersets_id: null, sets, ...o,
})
const routine = (title, exercises, o = {}) => ({
  id: 'b459cba5', title, folder_id: null,
  updated_at: '2021-09-14T12:00:00Z', created_at: '2021-09-14T12:00:00Z', exercises, ...o,
})

// A matcher that resolves anything containing a known word, so these tests exercise the
// mapping rather than the exercise database.
const match = n => (/bench|squat|deadlift|row|press/i.test(n) ? 'ex-' + n.toLowerCase().split(' ')[0] : undefined)

describe('repsOf', () => {
  it('takes a flat rep count', () => {
    expect(repsOf(set({ reps: 8 }))).toBe(8)
  })

  it('collapses a rep range to its low end — the count you committed to hitting', () => {
    expect(repsOf(set({ reps: null, rep_range: { start: 8, end: 12 } }))).toBe(8)
  })

  it('falls back to the top of a range when only that is given', () => {
    expect(repsOf(set({ reps: null, rep_range: { end: 12 } }))).toBe(12)
  })

  it('is null when there is no rep information at all', () => {
    expect(repsOf(set({ reps: null }))).toBe(null)
    expect(repsOf(set({ reps: null, rep_range: {} }))).toBe(null)
  })

  it('refuses a rep count outside anything a human logs', () => {
    expect(repsOf(set({ reps: 0 }))).toBe(null)
    expect(repsOf(set({ reps: 100000 }))).toBe(null)
  })
})

describe('mapRoutine', () => {
  it('maps title, exercises and set counts', () => {
    const r = mapRoutine(routine('Upper Body', [
      exercise('Bench Press (Barbell)', [set(), set({ index: 1 }), set({ index: 2 })]),
      exercise('Barbell Row', [set(), set({ index: 1 })], { index: 1 }),
    ]), { match })
    expect(r.routine.name).toBe('Upper Body')
    expect(r.routine.ex).toHaveLength(2)
    expect(r.routine.ex[0]).toMatchObject({ sets: 3, reps: 10, weight: 0 })
    expect(r.routine.ex[1]).toMatchObject({ sets: 2 })
  })

  it('excludes warm-up sets from the prescription', () => {
    // Two ramp-up sets behind three working ones must prescribe three, not five — the same
    // rule the CSV path applies via set_type.
    const r = mapRoutine(routine('Squat Day', [
      exercise('Squat (Barbell)', [
        set({ type: 'warmup' }), set({ type: 'warmup', index: 1 }),
        set({ index: 2 }), set({ index: 3 }), set({ index: 4 }),
      ]),
    ]), { match })
    expect(r.routine.ex[0].sets).toBe(3)
  })

  it('orders exercises by index, not array order', () => {
    const r = mapRoutine(routine('Mixed', [
      exercise('Barbell Row', [set()], { index: 2 }),
      exercise('Bench Press', [set()], { index: 0 }),
      exercise('Squat', [set()], { index: 1 }),
    ]), { match })
    expect(r.routine.ex.map(e => e.id)).toEqual(['ex-bench', 'ex-squat', 'ex-barbell'])
  })

  it('takes the modal rep count, so a 5/5/5/AMRAP finisher reads as 5', () => {
    const r = mapRoutine(routine('Strength', [
      exercise('Squat', [set({ reps: 5 }), set({ reps: 5, index: 1 }), set({ reps: 5, index: 2 }), set({ reps: 12, index: 3 })]),
    ]), { match })
    expect(r.routine.ex[0].reps).toBe(5)
  })

  it('keeps an exercise that has no sets yet, prescribing one', () => {
    // Hevy lets you add an exercise before deciding the volume. Dropping it would quietly
    // shorten the routine the user is looking at in the other app.
    const r = mapRoutine(routine('Draft', [exercise('Bench Press', [])]), { match })
    expect(r.routine.ex).toHaveLength(1)
    expect(r.routine.ex[0].sets).toBe(1)
  })

  it('creates a custom exercise for a title the library does not know', () => {
    const r = mapRoutine(routine('Odd', [exercise('Jefferson Curl', [set()])]), { match })
    expect(r.unmatched).toEqual(['Jefferson Curl'])
    expect(r.created).toHaveLength(1)
    expect(r.created[0]).toMatchObject({ n: 'jefferson curl', custom: true })
    expect(r.routine.ex[0].id).toBe(r.created[0].id)
  })

  it('returns null for a routine with no title or no usable exercise', () => {
    expect(mapRoutine(routine('', [exercise('Bench', [set()])]), { match })).toBe(null)
    expect(mapRoutine(routine('Empty', []), { match })).toBe(null)
    expect(mapRoutine(null, { match })).toBe(null)
  })
})

describe('mapRoutines', () => {
  it('maps a list and collects the unmatched names once', () => {
    const out = mapRoutines([
      routine('A', [exercise('Jefferson Curl', [set()])]),
      routine('B', [exercise('Jefferson Curl', [set()]), exercise('Bench Press', [set()], { index: 1 })]),
    ], { match })
    expect(out.routines).toHaveLength(2)
    expect(out.unmatchedNames).toEqual(['Jefferson Curl'])
    expect(out.customEx).toHaveLength(2)   // one per routine — mergeImport dedups by name
  })

  it('keeps the first of two routines sharing a name', () => {
    const out = mapRoutines([
      routine('Push', [exercise('Bench Press', [set(), set({ index: 1 })])]),
      routine('push', [exercise('Squat', [set()])]),
    ], { match })
    expect(out.routines).toHaveLength(1)
    expect(out.routines[0].ex[0].sets).toBe(2)
    expect(out.skipped).toBe(1)
  })

  it('survives junk in the list rather than throwing', () => {
    const out = mapRoutines([null, 'nope', 42, routine('Real', [exercise('Bench', [set()])])], { match })
    expect(out.routines).toHaveLength(1)
    expect(out.skipped).toBe(3)
  })
})

describe('applyRealRoutines', () => {
  const parsed = () => ({
    routines: [
      { id: 'd1', name: 'Push Day', emoji: '💪', ex: [{ id: 'ex-bench', sets: 5, reps: 5, weight: 0 }], sessions: 12 },
      { id: 'd2', name: 'Legs', emoji: '🦵', ex: [{ id: 'ex-squat', sets: 3, reps: 8, weight: 0 }], sessions: 7 },
    ],
    skippedRoutines: [{ name: 'Deload Week', sessions: 2, why: 'few' }],
    customEx: [], unmatchedNames: [],
    workouts: [{ id: 'w1', routineId: 'd1' }],
  })

  it('gives a real routine the derived id of the same name, so sessions stay linked', () => {
    const p = parsed()
    const out = applyRealRoutines(p, mapRoutines([
      routine('Push Day', [exercise('Bench Press', [set(), set({ index: 1 }), set({ index: 2 })])]),
    ], { match }))
    const push = out.routines.find(r => r.name === 'Push Day')
    expect(push.id).toBe('d1')                 // the workout still points here
    expect(push.ex[0].sets).toBe(3)            // but the contents are Hevy's, not the median
    expect(push.real).toBe(true)
    expect(push.sessions).toBe(12)
  })

  it('adds a routine that has never been trained — what derivation cannot do', () => {
    const out = applyRealRoutines(parsed(), mapRoutines([
      routine('New Split', [exercise('Deadlift', [set()])]),
    ], { match }))
    const fresh = out.routines.find(r => r.name === 'New Split')
    expect(fresh).toBeTruthy()
    expect(fresh.sessions).toBeUndefined()
  })

  it('keeps a derived routine Hevy no longer has, because its sessions still point at it', () => {
    const out = applyRealRoutines(parsed(), mapRoutines([
      routine('Push Day', [exercise('Bench Press', [set()])]),
    ], { match }))
    expect(out.routines.map(r => r.name).sort()).toEqual(['Legs', 'Push Day'])
  })

  it('drops a refusal that the real routines answer', () => {
    const out = applyRealRoutines(parsed(), mapRoutines([
      routine('Deload Week', [exercise('Squat', [set()])]),
    ], { match }))
    expect(out.skippedRoutines).toEqual([])
    expect(out.routines.find(r => r.name === 'Deload Week')).toBeTruthy()
  })

  it('keeps a refusal the real routines say nothing about', () => {
    const out = applyRealRoutines(parsed(), mapRoutines([
      routine('Push Day', [exercise('Bench Press', [set()])]),
    ], { match }))
    expect(out.skippedRoutines.map(s => s.name)).toEqual(['Deload Week'])
  })

  it('is a no-op when Hevy returned no routines', () => {
    const p = parsed()
    expect(applyRealRoutines(p, { routines: [] })).toBe(p)
    expect(applyRealRoutines(p, null)).toBe(p)
  })

  it('does not mutate the parsed import', () => {
    const p = parsed()
    applyRealRoutines(p, mapRoutines([routine('Push Day', [exercise('Bench Press', [set(), set({ index: 1 })])])], { match }))
    expect(p.routines.find(r => r.name === 'Push Day').ex[0].sets).toBe(5)
  })
})

/* ------------------------------------------------------------- transport -- */

const res = (status, body) => ({ ok: status < 400, status, json: async () => body })

describe('fetchRoutines', () => {
  it('asks for the routines resource, not workouts', async () => {
    let url
    await fetchRoutines('k', { fetchFn: async u => { url = u; return res(200, { routines: [], page_count: 1 }) } })
    expect(url).toContain('/routines?')
    expect(url).not.toContain('/workouts')
  })

  it('reads the list from the `routines` key and paginates', async () => {
    const fetchFn = async u => {
      const page = Number(new URL(u).searchParams.get('page'))
      return res(200, { page, page_count: 2, routines: [routine('R' + page, [exercise('Bench', [set()])])] })
    }
    const { routines } = await fetchRoutines('k', { fetchFn })
    expect(routines.map(r => r.title)).toEqual(['R1', 'R2'])
  })

  it('reports a rejected key rather than returning nothing', async () => {
    await expect(fetchRoutines('k', { fetchFn: async () => res(401, {}) }))
      .rejects.toMatchObject({ code: 'bad-key' })
  })
})

describe('syncHevy with routines', () => {
  const workout = () => ({
    title: 'Morning', start_time: '2024-03-01T08:00:00Z', end_time: '2024-03-01T09:00:00Z',
    exercises: [{ title: 'Bench Press (Barbell)', sets: [{ type: 'normal', weight_kg: 80, reps: 5 }] }],
  })
  const router = (routinesRes) => async u => {
    if (u.includes('/routines')) return routinesRes()
    const page = Number(new URL(u).searchParams.get('page'))
    return res(200, { page, page_count: 1, workouts: [workout()] })
  }

  it('returns the routines alongside the CSV', async () => {
    const out = await syncHevy('k', {
      fetchFn: router(() => res(200, { page: 1, page_count: 1, routines: [routine('Push', [exercise('Bench', [set()])])] })),
    })
    expect(out.csv).toContain('Morning')
    expect(out.routines).toHaveLength(1)
    expect(out.routinesError).toBe(null)
  })

  it('keeps the history when the routines endpoint fails, and says which failed', async () => {
    // The key already worked for /workouts, so a failure here is the endpoint. Losing the
    // plan must not cost the log.
    const out = await syncHevy('k', { fetchFn: router(() => res(404, {})) })
    expect(out.csv).toContain('Morning')
    expect(out.routines).toEqual([])
    expect(out.routinesError).toBe('http')
  })

  it('can be told not to ask for routines at all', async () => {
    let asked = false
    await syncHevy('k', {
      routines: false,
      fetchFn: async u => { if (u.includes('/routines')) asked = true; return router(() => res(200, {}))(u) },
    })
    expect(asked).toBe(false)
  })
})

/* ------------------------------------------------------------ into state -- */

describe('a real routine reaching state', () => {
  const state = over => ({ workouts: [], routines: [], customEx: [], bodyweight: [], exWeights: {}, ...over })

  // The rule mergeImport applies to *derived* routines — no fresh session, no routine —
  // is right for a reconstruction and wrong for a real plan. A browser run caught this:
  // the untrained routine showed on the confirm sheet and then silently never landed.
  it('lands even though no imported session points at it', () => {
    const S = state()
    const parsed = applyRealRoutines(
      { workouts: [], routines: [], skippedRoutines: [], customEx: [], unmatchedNames: [] },
      mapRoutines([routine('Written Last Night', [exercise('Bench Press', [set(), set({ index: 1 })])])], { match }),
    )
    mergeImport(S, parsed)
    expect(S.routines.map(r => r.name)).toEqual(['Written Last Night'])
  })

  it('is still refused when a derived routine of the same name is being added', () => {
    const S = state()
    const real = mapRoutines([routine('Push Day', [exercise('Bench Press', [set()])])], { match })
    const parsed = applyRealRoutines(
      { workouts: [], routines: [], skippedRoutines: [], customEx: [], unmatchedNames: [] }, real)
    mergeImport(S, parsed)
    mergeImport(S, parsed)                       // syncing twice must not grow a second copy
    expect(S.routines).toHaveLength(1)
  })

  it('does not overwrite a routine already in the plan under that name', () => {
    // The local one may have been edited here, so it wins. The confirm sheet says so.
    const S = state({ routines: [{ id: 'mine', name: 'Push Day', emoji: '💪', ex: [{ id: 'a', sets: 9, reps: 9, weight: 0 }] }] })
    const parsed = applyRealRoutines(
      { workouts: [], routines: [], skippedRoutines: [], customEx: [], unmatchedNames: [] },
      mapRoutines([routine('Push Day', [exercise('Bench Press', [set()])])], { match }),
    )
    mergeImport(S, parsed)
    expect(S.routines).toHaveLength(1)
    expect(S.routines[0].ex[0].sets).toBe(9)
  })

  it('stores neither `real` nor `sessions` — both are evidence for the sheet, not state', () => {
    const S = state()
    const parsed = applyRealRoutines(
      { workouts: [], routines: [], skippedRoutines: [], customEx: [], unmatchedNames: [] },
      mapRoutines([routine('Solo', [exercise('Bench Press', [set()])])], { match }),
    )
    mergeImport(S, parsed)
    expect(S.routines[0]).not.toHaveProperty('real')
    expect(S.routines[0]).not.toHaveProperty('sessions')
  })
})
