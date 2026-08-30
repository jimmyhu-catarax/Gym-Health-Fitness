import { describe, it, expect } from 'vitest'
import { decodeText, importIsEmpty, redactCredentials, CREDENTIAL_KEYS } from './import-file.js'

const utf8 = s => new TextEncoder().encode(s)
const withBom = (bom, bytes) => {
  const out = new Uint8Array(bom.length + bytes.length)
  out.set(bom, 0); out.set(bytes, bom.length)
  return out
}
/** Encode a string as UTF-16, little- or big-endian, the way Excel's "Unicode text" does. */
function utf16(s, little = true) {
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out[i * 2 + (little ? 0 : 1)] = c & 0xff
    out[i * 2 + (little ? 1 : 0)] = c >> 8
  }
  return out
}

const CSV = 'Cycle start time,Recovery score %\n2026-02-09 03:00:00,64\n'

describe('decodeText', () => {
  it('reads plain UTF-8', () => {
    expect(decodeText(utf8(CSV))).toBe(CSV)
  })

  it('drops a UTF-8 byte-order mark', () => {
    expect(decodeText(withBom([0xef, 0xbb, 0xbf], utf8(CSV)))).toBe(CSV)
  })

  it('reads UTF-16 little-endian, which is what Excel writes', () => {
    // "Save as -> Unicode text" produces this. Decoded as UTF-8 it is mojibake with a NUL
    // between every character, so no header matches and a good export is refused.
    expect(decodeText(withBom([0xff, 0xfe], utf16(CSV, true)))).toBe(CSV)
  })

  it('reads UTF-16 big-endian', () => {
    expect(decodeText(withBom([0xfe, 0xff], utf16(CSV, false)))).toBe(CSV)
  })

  it('does not mistake ordinary bytes for a mark', () => {
    // 0xEF 0xBB alone is not a BOM, and a file starting with them is still UTF-8.
    const text = 'Date,Exercise\n2026-01-01,Squat\n'
    expect(decodeText(utf8(text))).toBe(text)
  })

  it('keeps non-ASCII intact through every path', () => {
    const s = 'Übung,Kniebeuge,日本語\n'
    expect(decodeText(utf8(s))).toBe(s)
    expect(decodeText(withBom([0xef, 0xbb, 0xbf], utf8(s)))).toBe(s)
    expect(decodeText(withBom([0xff, 0xfe], utf16(s, true)))).toBe(s)
  })

  it('survives empty and tiny inputs', () => {
    expect(decodeText(new Uint8Array(0))).toBe('')
    expect(decodeText(new Uint8Array([0xff]))).toHaveLength(1)
  })

  it('accepts an ArrayBuffer as well as a view', () => {
    expect(decodeText(utf8(CSV).buffer)).toBe(CSV)
  })
})

describe('importIsEmpty', () => {
  it('does not throw on a physiology-only result', () => {
    // The bug this replaces: `!parsed.workouts.length` on a result that has no `workouts`
    // key threw a TypeError outside the try/catch, on the path a Whoop user most likely
    // takes — an export whose workouts.csv is absent or unparseable.
    const metrics = { kind: 'metrics', metrics: [{ d: '2026-02-09', recovery: 64 }] }
    expect(() => importIsEmpty(metrics)).not.toThrow()
    expect(importIsEmpty(metrics)).toBe(false)
  })

  it('calls a metrics result with no days empty', () => {
    expect(importIsEmpty({ kind: 'metrics', metrics: [] })).toBe(true)
  })

  it('handles body weight', () => {
    expect(importIsEmpty({ kind: 'bodyweight', bodyweight: [{ d: '2026-01-01', w: 78 }] })).toBe(false)
    expect(importIsEmpty({ kind: 'bodyweight', bodyweight: [] })).toBe(true)
  })

  it('handles workouts', () => {
    expect(importIsEmpty({ kind: 'workouts', workouts: [{ d: '2026-01-01' }] })).toBe(false)
    expect(importIsEmpty({ kind: 'workouts', workouts: [] })).toBe(true)
  })

  it('keeps a workouts result that carries physiology but no sessions', () => {
    // A Whoop export whose workouts.csv is empty but whose cycles are full still has plenty
    // worth importing, and calling it empty would throw the physiology away.
    expect(importIsEmpty({ kind: 'workouts', workouts: [], metrics: [{ d: '2026-02-09' }] })).toBe(false)
  })

  it('lets an unknown kind through rather than swallowing it', () => {
    // An importer added later should reach its summary sheet, not be discarded by a guard
    // that has never heard of it.
    expect(importIsEmpty({ kind: 'something-new', rows: [1, 2, 3] })).toBe(false)
  })

  it('treats nothing at all as empty', () => {
    for (const v of [null, undefined, 'nope', 42]) expect(importIsEmpty(v)).toBe(true)
  })
})

describe('redactCredentials', () => {
  it('blanks the Hevy key so a shared backup does not carry one', () => {
    const S = { unit: 'kg', hevyKey: 'live-key', workouts: [{ d: '2026-08-01' }] }
    const out = redactCredentials(S)
    expect(out.hevyKey).toBeNull()
    expect(out.workouts).toBe(S.workouts)   // everything else passes through untouched
    expect(out.unit).toBe('kg')
  })

  it('does not mutate the live state it was handed', () => {
    const S = { hevyKey: 'live-key' }
    redactCredentials(S)
    expect(S.hevyKey).toBe('live-key')
  })

  it('leaves a state that never had one alone', () => {
    expect(redactCredentials({ unit: 'kg' })).toEqual({ unit: 'kg' })
    expect(redactCredentials(null)).toBeNull()
  })

  it('covers every key it claims to', () => {
    const S = Object.fromEntries(CREDENTIAL_KEYS.map(k => [k, 'secret']))
    expect(Object.values(redactCredentials(S)).every(v => v === null)).toBe(true)
  })
})
