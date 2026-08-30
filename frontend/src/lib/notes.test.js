import { describe, it, expect } from 'vitest'
import { cleanNote, mergeNote, hasNotes, countNotes, NOTE_MAX } from './notes.js'
import { parseWorkoutCSV } from './import-csv.js'

describe('cleanNote', () => {
  it('treats absent, empty and whitespace-only as the same absent note', () => {
    // The three have to collapse together or history renders a bubble for nothing:
    // Hevy writes the description column on every row whether or not there is one.
    expect(cleanNote(null)).toBe(null)
    expect(cleanNote(undefined)).toBe(null)
    expect(cleanNote('')).toBe(null)
    expect(cleanNote('   \n  ')).toBe(null)
  })

  it('normalises CRLF so a note typed here equals the same note through a file', () => {
    expect(cleanNote('felt heavy\r\nbelt on')).toBe('felt heavy\nbelt on')
    expect(cleanNote('a\rb')).toBe('a\nb')
  })

  it('caps a pathological cell rather than letting it into localStorage', () => {
    const out = cleanNote('x'.repeat(NOTE_MAX + 500))
    expect(out).toHaveLength(NOTE_MAX)
  })

  it('keeps the beginning when it caps, because people front-load the point', () => {
    expect(cleanNote('the point' + ' '.repeat(NOTE_MAX)).startsWith('the point')).toBe(true)
  })
})

describe('mergeNote', () => {
  it('collapses the repeat an exporter writes on every row', () => {
    // Hevy repeats a session's description once per set row. Eight sets must not
    // produce the same sentence eight times.
    let note = null
    for (let i = 0; i < 8; i++) note = mergeNote(note, 'slept badly, kept it light')
    expect(note).toBe('slept badly, kept it light')
  })

  it('keeps genuinely different text, because one exercise can carry two notes', () => {
    expect(mergeNote('felt heavy', 'belt from 100kg')).toBe('felt heavy · belt from 100kg')
  })

  it('does not re-add a fragment already folded in', () => {
    const first = mergeNote('felt heavy', 'belt on')
    expect(mergeNote(first, 'felt heavy')).toBe('felt heavy · belt on')
    expect(mergeNote(first, 'belt on')).toBe('felt heavy · belt on')
  })

  it('an empty incoming note leaves what is there alone', () => {
    expect(mergeNote('felt heavy', '')).toBe('felt heavy')
    expect(mergeNote('felt heavy', '   ')).toBe('felt heavy')
    expect(mergeNote(null, '')).toBe(null)
  })
})

describe('hasNotes / countNotes', () => {
  it('sees a note at either level', () => {
    expect(hasNotes({ note: 'x', entries: [] })).toBe(true)
    expect(hasNotes({ entries: [{ note: 'x' }] })).toBe(true)
    expect(hasNotes({ entries: [{}] })).toBe(false)
    expect(hasNotes(null)).toBe(false)
  })

  it('counts both levels across a parsed import', () => {
    expect(countNotes([
      { note: 'a', entries: [{ note: 'b' }, {}] },
      { entries: [{ note: 'c' }] },
    ])).toBe(3)
    expect(countNotes([])).toBe(0)
    expect(countNotes(undefined)).toBe(0)
  })
})

/* ------------------------------------------------------------------ import -- */

const HEVY = [
  'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
  'Push Day,2026-05-04 07:00:00,2026-05-04 08:00:00,slept badly - kept it light,Bench Press (Barbell),,left shoulder twinge,0,warmup,40,10,,,',
  'Push Day,2026-05-04 07:00:00,2026-05-04 08:00:00,slept badly - kept it light,Bench Press (Barbell),,left shoulder twinge,1,normal,82.5,8,,,8',
  'Push Day,2026-05-04 07:00:00,2026-05-04 08:00:00,slept badly - kept it light,Overhead Press (Barbell),,belt from set 2,0,normal,45,8,,,7',
].join('\n')

describe('notes survive a Hevy import', () => {
  it('reads the session description and each exercise note', () => {
    const r = parseWorkoutCSV(HEVY, { unit: 'kg' })
    const w = r.workouts[0]
    expect(w.note).toBe('slept badly - kept it light')
    expect(w.entries[0].note).toBe('left shoulder twinge')
    expect(w.entries[1].note).toBe('belt from set 2')
  })

  it('does not repeat the description once per row', () => {
    // The regression this whole module exists to prevent, from the other direction:
    // three rows carry the same description and it must land exactly once.
    const w = parseWorkoutCSV(HEVY, { unit: 'kg' }).workouts[0]
    expect(w.note.match(/slept badly/g)).toHaveLength(1)
  })

  it('reports the count so the confirm sheet can show it before writing', () => {
    expect(parseWorkoutCSV(HEVY, { unit: 'kg' }).notes).toBe(3)
  })

  it('leaves the key off entirely when a file carries no notes', () => {
    // An empty string in state would round-trip into an export as a note nobody wrote.
    const bare = HEVY.split('\n').map((l, i) => i === 0 ? l : l.replace('slept badly - kept it light', '').replace('left shoulder twinge', '').replace('belt from set 2', '')).join('\n')
    const w = parseWorkoutCSV(bare, { unit: 'kg' }).workouts[0]
    expect('note' in w).toBe(false)
    expect(w.entries.every(e => !('note' in e))).toBe(true)
  })
})

describe('notes survive a Strong import', () => {
  // Strong writes both levels under different names: `Notes` per set, `Workout Notes` per session.
  const STRONG = [
    'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Notes,Workout Notes,RPE',
    '2026-05-06 18:00:00,Legs,60m,Squat (Barbell),1,100,5,depth felt good,long day at work,8',
    '2026-05-06 18:00:00,Legs,60m,Squat (Barbell),2,100,5,depth felt good,long day at work,9',
  ].join('\n')

  it('maps Workout Notes to the session and Notes to the exercise', () => {
    const w = parseWorkoutCSV(STRONG, { unit: 'kg' }).workouts[0]
    expect(w.note).toBe('long day at work')
    expect(w.entries[0].note).toBe('depth felt good')
  })
})

describe('notes survive a FitNotes import', () => {
  // FitNotes has one free-text column, `Comment`, and no session-level note at all.
  const FITNOTES = [
    'Date,Exercise,Category,Weight,Weight Unit,Reps,Distance,Distance Unit,Time,Comment',
    '2026-05-07,Deadlift,Back,140,kg,3,,,,straps from here',
  ].join('\n')

  it('reads Comment as the exercise note and leaves the session note absent', () => {
    const w = parseWorkoutCSV(FITNOTES, { unit: 'kg' }).workouts[0]
    expect(w.entries[0].note).toBe('straps from here')
    expect('note' in w).toBe(false)
  })
})
