/**
 * Workout and exercise notes — the free text a lifter writes next to their sets.
 *
 * Every logging app has them and they carry the things numbers cannot: "left shoulder
 * twinged on set 3", "belt from 100kg", "felt heavy, slept badly". They are also the
 * first thing an importer drops, because they are the one column that cannot be
 * validated — and dropping them is silent, which is what makes it worth a module.
 *
 * Two levels, matching what the source files actually carry:
 *
 *   workout.note          one per session   (Hevy writes it as `description`)
 *   workout.entries[].note one per exercise (Hevy writes it as `exercise_notes`)
 *
 * The rules below exist because a note arrives from three directions — typed here,
 * read from a CSV, mapped from Hevy's API — and all three have to agree on what an
 * absent note looks like, or history renders an empty bubble for a note nobody wrote.
 */

// Long enough for anything a person types about a set; short enough that one pathological
// cell in a 20 MB CSV cannot push the whole state past a browser's storage quota. State
// lives in localStorage, so an unbounded string here is a real failure mode, not a tidiness
// concern. A note that hits the cap keeps its beginning: people front-load the point.
export const NOTE_MAX = 2000

/**
 * A stored note, or null.
 *
 * Absent and empty are deliberately the same thing on the way in and distinguishable
 * nowhere after: `''` in state would render as an empty note bubble in history and
 * round-trip into an export as a note the user never wrote. Whitespace-only cells are
 * common in exported CSVs — Hevy writes the description column on every row of a session
 * whether or not there is one — so they collapse to absent too.
 */
export function cleanNote(v) {
  if (v == null) return null
  // Normalise the line endings a CSV brings with it, so a note typed here and the same
  // note round-tripped through a file compare equal rather than differing invisibly.
  const s = String(v).replace(/\r\n?/g, '\n').trim()
  if (!s) return null
  return s.length > NOTE_MAX ? s.slice(0, NOTE_MAX).trimEnd() : s
}

/**
 * Fold one more note into what a day already has.
 *
 * Written for the shape the exporters actually use: Hevy repeats a workout's description
 * on every single row of that workout, and an exercise's notes on every set row. Naive
 * concatenation would file the same sentence eight times. So identical text collapses —
 * but genuinely different text is kept, because the same exercise trained twice in one
 * session can carry two different notes, and picking one would silently lose the other.
 *
 * The separator is a middle dot rather than a newline: these are fragments being joined
 * by the importer, not paragraphs the user laid out.
 */
export function mergeNote(existing, incoming) {
  const add = cleanNote(incoming)
  if (!add) return cleanNote(existing)
  const have = cleanNote(existing)
  if (!have) return add
  // Substring rather than equality: a note already folded in reappears verbatim on every
  // later row, and re-adding it would grow the string once per set.
  if (have === add || have.split(' · ').includes(add)) return have
  return cleanNote(have + ' · ' + add)
}

/** Does this workout carry anything written, at either level? */
export function hasNotes(w) {
  if (!w) return false
  return !!w.note || (w.entries || []).some(e => !!e.note)
}

/** How many notes a parsed import carries — the confirm sheet reports it before writing. */
export function countNotes(workouts) {
  let n = 0
  for (const w of workouts || []) {
    if (w.note) n++
    for (const e of w.entries || []) if (e.note) n++
  }
  return n
}
