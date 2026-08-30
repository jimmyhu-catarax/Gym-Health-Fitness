import { describe, it, expect } from 'vitest'
import { workoutsToCsv, fetchPage, fetchWorkouts, syncHevy, HevyError, HEVY_MESSAGE } from './hevy-api.js'
import { parseWorkoutCSV, detectSource, parseCSV } from './import-csv.js'

/** One workout in the shape Hevy documents. */
const workout = (over = {}) => ({
  id: 'w1',
  title: 'Push Day',
  start_time: '2026-08-24T17:05:00Z',
  end_time: '2026-08-24T18:02:00Z',
  description: '',
  exercises: [{
    title: 'Bench Press (Barbell)',
    exercise_template_id: 'bench',
    superset_id: null,
    notes: '',
    sets: [
      { index: 0, type: 'warmup', weight_kg: 40, reps: 10, rpe: null },
      { index: 1, type: 'normal', weight_kg: 80, reps: 8, rpe: 8 },
      { index: 2, type: 'normal', weight_kg: 80, reps: 7, rpe: 9 },
    ],
  }],
  ...over,
})

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('workoutsToCsv', () => {
  it('emits the header Hevy itself exports, so the CSV reader needs no new column', () => {
    const { csv } = workoutsToCsv([workout()])
    expect(detectSource(parseCSV(csv)[0])).toBe('Hevy')
  })

  it('round-trips through the CSV reader into workouts', () => {
    const { csv, workouts, sets } = workoutsToCsv([workout()])
    expect(workouts).toBe(1)
    expect(sets).toBe(3)

    const p = parseWorkoutCSV(csv, { unit: 'kg' })
    expect(p.error).toBeUndefined()
    expect(p.source).toBe('Hevy')
    expect(p.workouts).toHaveLength(1)
    const w = p.workouts[0]
    expect(w.d).toBe('2026-08-24')
    expect(w.name).toBe('Push Day')
    const e = w.entries[0]
    expect(e.sets).toHaveLength(3)
    expect(e.sets.map(s => s.w)).toEqual([40, 80, 80])
    expect(e.sets.map(s => s.r)).toEqual([10, 8, 7])
  })

  it('carries the warm-up flag through, so it is not prescribed as a working set', () => {
    const p = parseWorkoutCSV(workoutsToCsv([workout()]).csv, { unit: 'kg' })
    const sets = p.workouts[0].entries[0].sets
    expect(sets[0].wu).toBeTruthy()
    expect(sets[1].wu).toBeFalsy()
    expect(p.warmups).toBe(1)
  })

  it('keeps the RPE Hevy logged', () => {
    const p = parseWorkoutCSV(workoutsToCsv([workout()]).csv, { unit: 'kg' })
    const sets = p.workouts[0].entries[0].sets
    expect(sets[1].rpe).toBe(8)
    expect(sets[2].rpe).toBe(9)
    expect(p.rpeSets).toBe(2)
  })

  it('converts metres to kilometres — a raw 5000 read as km is a 5000 km run', () => {
    const run = workout({
      title: 'Run',
      exercises: [{ title: 'Running', sets: [{ index: 0, type: 'normal', distance_meters: 5000, duration_seconds: 1500 }] }],
    })
    const { csv } = workoutsToCsv([run])
    const row = parseCSV(csv)[1]
    const km = row[parseCSV(csv)[0].indexOf('distance_km')]
    expect(Number(km)).toBe(5)
  })

  it('takes distance_km unchanged when that is what it is given', () => {
    const run = workout({ exercises: [{ title: 'Running', sets: [{ distance_km: 5 }] }] })
    const head = parseCSV(workoutsToCsv([run]).csv)[0]
    const row = parseCSV(workoutsToCsv([run]).csv)[1]
    expect(Number(row[head.indexOf('distance_km')])).toBe(5)
  })

  it('survives a title with a comma in it', () => {
    const p = parseWorkoutCSV(workoutsToCsv([workout({ title: 'Push, Pull, Legs' })]).csv, { unit: 'kg' })
    expect(p.workouts[0].name).toBe('Push, Pull, Legs')
  })

  it('reads camelCase too, in case the envelope is ever spelled that way', () => {
    const camel = {
      title: 'Pull Day',
      startTime: '2026-08-25T17:00:00Z',
      exercises: [{ name: 'Deadlift (Barbell)', sets: [{ weightKg: 140, reps: 5 }] }],
    }
    const p = parseWorkoutCSV(workoutsToCsv([camel]).csv, { unit: 'kg' })
    expect(p.workouts[0].d).toBe('2026-08-25')
    expect(p.workouts[0].entries[0].sets[0].w).toBe(140)
  })

  it('drops a value outside its plausible range rather than importing it', () => {
    // A field that turned out to hold something else entirely — an id, a timestamp.
    const odd = workout({
      exercises: [{ title: 'Bench Press (Barbell)', sets: [{ weight_kg: 1756000000, reps: 8 }] }],
    })
    const p = parseWorkoutCSV(workoutsToCsv([odd]).csv, { unit: 'kg' })
    expect(p.workouts[0].entries[0].sets[0].w).toBe(0)
  })

  it('refuses a response it does not recognise instead of importing nothing quietly', () => {
    expect(() => workoutsToCsv([{ foo: 1 }])).toThrow(HevyError)
    expect(() => workoutsToCsv([])).toThrow(/Hevy workout/)
    // A workout with a time but no exercises is not an import, it is a shape mismatch.
    expect(() => workoutsToCsv([{ start_time: '2026-08-24T17:00:00Z', exercises: [] }])).toThrow(HevyError)
  })

  it('skips one unusable workout without failing the rest', () => {
    const { workouts } = workoutsToCsv([{ title: 'broken' }, workout()])
    expect(workouts).toBe(1)
  })
})

describe('fetchPage', () => {
  const key = 'k'

  it('sends the key as the api-key header Hevy allows through CORS', async () => {
    let seen = null
    await fetchPage(key, 1, { fetchFn: async (url, init) => { seen = { url, init }; return res(200, { workouts: [], page_count: 1 }) } })
    expect(seen.init.headers['api-key']).toBe('k')
    expect(seen.url).toContain('/workouts?page=1')
  })

  it('tells a wrong key and a free account apart', async () => {
    await expect(fetchPage(key, 1, { fetchFn: async () => res(401, {}) })).rejects.toMatchObject({ code: 'bad-key' })
    await expect(fetchPage(key, 1, { fetchFn: async () => res(403, {}) })).rejects.toMatchObject({ code: 'needs-pro' })
    await expect(fetchPage(key, 1, { fetchFn: async () => res(429, {}) })).rejects.toMatchObject({ code: 'rate-limit' })
    await expect(fetchPage(key, 1, { fetchFn: async () => res(500, {}) })).rejects.toMatchObject({ code: 'http' })
  })

  it('reports an unreachable API as offline rather than as a bad key', async () => {
    await expect(fetchPage(key, 1, { fetchFn: async () => { throw new TypeError('failed to fetch') } }))
      .rejects.toMatchObject({ code: 'offline' })
  })

  it('refuses an empty key before making a request', async () => {
    let called = false
    await expect(fetchPage('  ', 1, { fetchFn: async () => { called = true; return res(200, {}) } }))
      .rejects.toMatchObject({ code: 'no-key' })
    expect(called).toBe(false)
  })

  it('refuses an unfamiliar envelope', async () => {
    await expect(fetchPage(key, 1, { fetchFn: async () => res(200, { unexpected: true }) }))
      .rejects.toMatchObject({ code: 'shape' })
  })

  it('accepts a bare array, in case the envelope is ever dropped', async () => {
    const r = await fetchPage(key, 1, { fetchFn: async () => res(200, [workout()]) })
    expect(r.workouts).toHaveLength(1)
  })
})

describe('fetchWorkouts', () => {
  const pages = n => async url => {
    const p = Number(new URL(url).searchParams.get('page'))
    return res(200, { page: p, page_count: n, workouts: p <= n ? [workout({ id: 'w' + p })] : [] })
  }

  it('walks every page the API says there is', async () => {
    const { workouts } = await fetchWorkouts('k', { fetchFn: pages(3) })
    expect(workouts).toHaveLength(3)
  })

  it('stops at the page cap rather than paginating forever', async () => {
    const { workouts, truncated } = await fetchWorkouts('k', { fetchFn: pages(9999), maxPages: 4 })
    expect(workouts).toHaveLength(4)
    expect(truncated).toBe(true)
  })

  it('stops early on an empty page even when the count disagrees', async () => {
    const { workouts } = await fetchWorkouts('k', {
      fetchFn: async url => {
        const p = Number(new URL(url).searchParams.get('page'))
        return res(200, { page_count: 50, workouts: p === 1 ? [workout()] : [] })
      },
    })
    expect(workouts).toHaveLength(1)
  })
})

describe('syncHevy', () => {
  it('hands back CSV ready for the normal import path', async () => {
    const r = await syncHevy('k', { fetchFn: async () => res(200, { workouts: [workout()], page_count: 1 }) })
    expect(r.workouts).toBe(1)
    expect(parseWorkoutCSV(r.csv, { unit: 'kg' }).workouts).toHaveLength(1)
  })

  it('says so rather than importing nothing when the account is empty', async () => {
    await expect(syncHevy('k', { fetchFn: async () => res(200, { workouts: [], page_count: 1 }) }))
      .rejects.toMatchObject({ code: 'empty' })
  })

  it('has a message for every code it can throw', () => {
    for (const code of ['no-key', 'bad-key', 'needs-pro', 'rate-limit', 'offline', 'http', 'shape', 'empty']) {
      expect(HEVY_MESSAGE[code]).toBeTruthy()
    }
  })
})
