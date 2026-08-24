import { describe, it, expect } from 'vitest'
import { deflateRawSync, crc32 } from 'node:zlib'
import { unzip, looksLikeZip } from './unzip.js'

/* A small ZIP writer, so the fixtures are real archives rather than recorded bytes —
   the point of these tests is that the reader agrees with the format, and a base64 blob
   nobody can read would only prove it agrees with itself. */
const LOC = 0x04034b50, CDH = 0x02014b50, EOCD = 0x06054b50

function zip(files) {
  const enc = new TextEncoder()
  const parts = [], central = []
  let offset = 0
  for (const { name, body, store } of files) {
    const nameB = enc.encode(name)
    const raw = enc.encode(body)
    const data = store ? raw : new Uint8Array(deflateRawSync(Buffer.from(raw)))
    const sum = crc32 ? crc32(Buffer.from(raw)) : 0
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, LOC, true); lh.setUint16(4, 20, true)
    lh.setUint16(8, store ? 0 : 8, true)
    lh.setUint32(14, sum, true)
    lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true)
    lh.setUint16(26, nameB.length, true)
    parts.push(new Uint8Array(lh.buffer), nameB, data)

    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, CDH, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true)
    ch.setUint16(10, store ? 0 : 8, true)
    ch.setUint32(16, sum, true)
    ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true)
    ch.setUint16(28, nameB.length, true)
    ch.setUint32(42, offset, true)
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

const CSV = 'Date,Exercise,Weight,Reps\n2024-03-07,"Bench Press, Close Grip",60,8\n'

describe('unzip', () => {
  it('reads a deflated entry back byte for byte', async () => {
    const entries = await unzip(zip([{ name: 'a.csv', body: CSV }]))
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('a.csv')
    expect(entries[0].size).toBe(CSV.length)
    expect(await entries[0].text()).toBe(CSV)
  })

  it('reads a stored (uncompressed) entry', async () => {
    // Takeout stores already-compressed members without deflating them, so method 0 is
    // not a hypothetical branch.
    const [e] = await unzip(zip([{ name: 'plain.txt', body: 'hello', store: true }]))
    expect(await e.text()).toBe('hello')
  })

  it('keeps nested Takeout-style paths intact', async () => {
    const name = 'Takeout/Fit/Daily activity metrics/Daily activity metrics.csv'
    const [e] = await unzip(zip([{ name, body: CSV }]))
    expect(e.name).toBe(name)
  })

  it('finds every entry in a multi-file archive, in order', async () => {
    const entries = await unzip(zip([
      { name: 'one.csv', body: 'a' },
      { name: 'two.csv', body: 'bb', store: true },
      { name: 'three.csv', body: 'ccc' },
    ]))
    expect(entries.map(e => e.name)).toEqual(['one.csv', 'two.csv', 'three.csv'])
    expect(await Promise.all(entries.map(e => e.text()))).toEqual(['a', 'bb', 'ccc'])
  })

  it('marks directory entries and reads them as empty', async () => {
    const entries = await unzip(zip([{ name: 'dir/', body: '', store: true }, { name: 'dir/f.csv', body: 'x' }]))
    expect(entries[0].dir).toBe(true)
    expect(await entries[0].text()).toBe('')
    expect(entries[1].dir).toBe(false)
  })

  it('round-trips UTF-8 in both names and contents', async () => {
    const [e] = await unzip(zip([{ name: 'Übung/日本.csv', body: 'Kniebeuge,90 kg,日本語\n' }]))
    expect(e.name).toBe('Übung/日本.csv')
    expect(await e.text()).toBe('Kniebeuge,90 kg,日本語\n')
  })

  it('survives a trailing archive comment', async () => {
    // The EOCD is found by scanning backwards, so a comment after it must not hide it.
    const base = zip([{ name: 'a.csv', body: CSV }])
    const withComment = new Uint8Array(base.length + 5)
    withComment.set(base, 0)
    new DataView(withComment.buffer).setUint16(base.length - 2, 5, true)
    withComment.set(new TextEncoder().encode('hello'), base.length)
    const [e] = await unzip(withComment)
    expect(await e.text()).toBe(CSV)
  })

  it('rejects something that is not a zip', async () => {
    await expect(unzip(new TextEncoder().encode('Date,Exercise\n2024-01-01,Squat\n')))
      .rejects.toThrow('not-a-zip')
  })

  it('does not inflate an entry until it is asked for', async () => {
    // The whole reason the archive is lazy: a Takeout export holds thousands of TCX files
    // and we want three of them. Corrupting one entry's payload must not break reading a
    // different one.
    const good = zip([{ name: 'good.csv', body: CSV }, { name: 'bad.csv', body: 'x'.repeat(200) }])
    good[good.length - 40] ^= 0xff       // scribble inside the second entry's data
    const entries = await unzip(good)
    expect(entries.map(e => e.name)).toEqual(['good.csv', 'bad.csv'])
    expect(await entries[0].text()).toBe(CSV)
  })
})

describe('looksLikeZip', () => {
  it('recognises an archive by its signature', () => {
    expect(looksLikeZip(zip([{ name: 'a.csv', body: 'x' }]))).toBe(true)
  })
  it('does not mistake a CSV or an XML export for one', () => {
    expect(looksLikeZip(new TextEncoder().encode('Date,Exercise\n'))).toBe(false)
    expect(looksLikeZip(new TextEncoder().encode('<?xml version="1.0"?>'))).toBe(false)
  })
  it('is not fooled by a file shorter than the signature', () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false)
  })
})
