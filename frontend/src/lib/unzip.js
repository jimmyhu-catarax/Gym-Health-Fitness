// A ZIP reader in ~120 lines, with no dependency.
//
// Google Takeout and Whoop both hand you a .zip, and the interesting part is a couple of
// CSV/JSON files buried in it. Pulling in a zip library for that would break the project's
// dependency-light rule (CONTRIBUTING.md), and it isn't necessary: every browser this app
// targets can already inflate, via DecompressionStream('deflate-raw'). So this walks the
// central directory itself and hands the compressed bytes to the platform.
//
// Entries are lazy — `text()` inflates on demand. A Takeout archive can hold thousands of
// TCX files we don't want, and inflating all of them to find three would be the slow way to
// read a large file.
//
// Reads the central directory rather than scanning local headers, because an entry written
// with a streaming data descriptor (bit 3) carries zeroes for its sizes in the local header
// and the real numbers only in the central directory. Zip64 is honoured where it appears;
// what isn't supported (encryption, and compression methods other than store/deflate) is
// reported as an error rather than being decoded into plausible-looking nonsense.

const EOCD_SIG = 0x06054b50
const EOCD64_SIG = 0x06064b50
const LOC64_SIG = 0x07064b50
const CDH_SIG = 0x02014b50

const u8OfEntryName = (u8, at, len) => new TextDecoder().decode(u8.subarray(at, at + len))

/** Walk back from the end for the End Of Central Directory record (it may carry a comment). */
function findEOCD(dv, len) {
  const floor = Math.max(0, len - 22 - 0xffff)
  for (let i = len - 22; i >= floor; i--) if (dv.getUint32(i, true) === EOCD_SIG) return i
  return -1
}

/**
 * Zip64: the 32-bit EOCD stores 0xFFFF/0xFFFFFFFF as "look in the 64-bit record". Reading
 * those sentinels literally would mean seeking to offset 4294967295 and failing, or worse,
 * reading 65535 entries out of an archive that has more.
 */
function eocd64(dv, eocd) {
  const loc = eocd - 20
  if (loc < 0 || dv.getUint32(loc, true) !== LOC64_SIG) return null
  const at = Number(dv.getBigUint64(loc + 8, true))
  if (at < 0 || at + 56 > dv.byteLength || dv.getUint32(at, true) !== EOCD64_SIG) return null
  return { count: Number(dv.getBigUint64(at + 32, true)), start: Number(dv.getBigUint64(at + 48, true)) }
}

/**
 * The Zip64 extended-information extra field (0x0001) restates whichever of
 * uncompressed size / compressed size / local-header offset overflowed 32 bits, in that
 * order, and only for the ones that did — so the fields have to be consumed in sequence.
 */
function zip64Extra(dv, at, len, need) {
  const end = at + len
  while (at + 4 <= end) {
    const id = dv.getUint16(at, true), size = dv.getUint16(at + 2, true)
    if (id === 0x0001) {
      let p = at + 4
      const out = {}
      for (const field of need) {
        if (p + 8 > at + 4 + size) break
        out[field] = Number(dv.getBigUint64(p, true)); p += 8
      }
      return out
    }
    at += 4 + size
  }
  return {}
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Read a ZIP into its entries.
 *
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {Promise<Array<{name:string, size:number, dir:boolean, text:()=>Promise<string>}>>}
 * @throws {Error} 'not-a-zip' if there is no central directory to read.
 */
export async function unzip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const eocd = findEOCD(dv, u8.byteLength)
  if (eocd < 0) throw new Error('not-a-zip')

  const wide = eocd64(dv, eocd)
  let count = wide ? wide.count : dv.getUint16(eocd + 10, true)
  let p = wide ? wide.start : dv.getUint32(eocd + 16, true)

  const out = []
  for (let i = 0; i < count && p + 46 <= u8.byteLength; i++) {
    if (dv.getUint32(p, true) !== CDH_SIG) break
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const nlen = dv.getUint16(p + 28, true)
    const elen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const name = u8OfEntryName(u8, p + 46, nlen)
    let csize = dv.getUint32(p + 20, true)
    let usize = dv.getUint32(p + 24, true)
    let lho = dv.getUint32(p + 42, true)

    // Which of the three overflowed decides what the Zip64 extra field actually contains.
    const need = []
    if (usize === 0xffffffff) need.push('usize')
    if (csize === 0xffffffff) need.push('csize')
    if (lho === 0xffffffff) need.push('lho')
    if (need.length) {
      const w = zip64Extra(dv, p + 46 + nlen, elen, need)
      if (w.usize !== undefined) usize = w.usize
      if (w.csize !== undefined) csize = w.csize
      if (w.lho !== undefined) lho = w.lho
    }
    p += 46 + nlen + elen + clen

    const dir = name.endsWith('/')
    const encrypted = (flags & 0x1) !== 0
    async function bytes() {
      if (dir) return new Uint8Array(0)
      if (encrypted) throw new Error('encrypted')
      if (method !== 0 && method !== 8) throw new Error('unsupported-method')
      // The local header repeats the name and carries its own extra field, whose length
      // differs from the central one — so the data offset has to be read from it, not
      // computed from the central directory's lengths.
      if (lho + 30 > u8.byteLength) throw new Error('truncated')
      const lnlen = dv.getUint16(lho + 26, true)
      const lelen = dv.getUint16(lho + 28, true)
      const at = lho + 30 + lnlen + lelen
      const raw = u8.subarray(at, at + csize)
      return method === 0 ? raw : inflateRaw(raw)
    }
    out.push({
      name,
      size: usize,
      dir,
      bytes,
      // Separate from bytes() because a Health Connect backup is a SQLite database, and
      // decoding those bytes as text would corrupt them on the way through.
      async text() { return new TextDecoder().decode(await bytes()) },
    })
  }
  if (!out.length) throw new Error('not-a-zip')
  return out
}

/** True if the bytes start with a local-file-header or empty-archive signature. */
export function looksLikeZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b &&
    (u8[2] === 3 || u8[2] === 5 || u8[2] === 7) && (u8[3] === 4 || u8[3] === 6 || u8[3] === 8)
}
