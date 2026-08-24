// Enough of the SQLite file format to read tables out of a Health Connect backup.
//
// Health Connect is the only way off an Android phone now that Google Fit's user-data APIs
// are winding down, and its export is not a CSV — "Back up & restore" writes a
// `Health Connect.zip` holding a raw, unencrypted SQLite database. Reading it the usual way
// would mean sql.js, which is a megabyte of WASM for one import path; CONTRIBUTING makes a
// new dependency a hard sell and this is not the place to spend it.
//
// So: the header, the table b-trees, the record format, and overflow chains. Read-only, and
// deliberately narrow — no indices, no WAL, no expression handling, nothing that writes.
// Anything outside that raises instead of returning a plausible-looking row, because the
// caller is about to put these numbers in somebody's weight chart.
//
// The format is specified at https://www.sqlite.org/fileformat.html and the offsets below
// name the parts they come from.

const MAGIC = 'SQLite format 3\0'

const PAGE_INTERIOR_TABLE = 5
const PAGE_LEAF_TABLE = 13

/** A varint: up to 9 bytes, 7 bits each, big-endian; the 9th byte contributes all 8 bits. */
function varint(u8, at) {
  let v = 0n
  for (let i = 0; i < 8; i++) {
    const b = u8[at + i]
    if (b === undefined) throw new Error('truncated varint')
    if (i === 8) break
    v = (v << 7n) | BigInt(b & 0x7f)
    if (!(b & 0x80)) return [v, i + 1]
  }
  const b = u8[at + 8]
  if (b === undefined) throw new Error('truncated varint')
  return [(v << 8n) | BigInt(b), 9]
}
// Row ids and payload lengths are read as varints but used as ordinary numbers; only the
// stored INTEGER values need to stay wide, and those are handled in readRecord.
const vnum = (u8, at) => { const [v, n] = varint(u8, at); return [Number(v), n] }

/**
 * Serial types, per the record format:
 *   0 NULL · 1..6 big-endian ints of 1,2,3,4,6,8 bytes · 7 float64 · 8 the constant 0
 *   9 the constant 1 · even >=12 a blob of (n-12)/2 bytes · odd >=13 text of (n-13)/2 bytes
 */
function sizeOfSerial(t) {
  if (t === 0 || t === 8 || t === 9) return 0
  if (t <= 4) return t
  if (t === 5) return 6
  if (t === 6 || t === 7) return 8
  if (t === 10 || t === 11) throw new Error('reserved serial type')
  return Math.floor((t - 12) / 2)
}
function readSerial(dv, u8, at, t, decoder) {
  if (t === 0) return null
  if (t === 8) return 0
  if (t === 9) return 1
  if (t >= 1 && t <= 6) {
    const len = sizeOfSerial(t)
    // Two's-complement big-endian. Assembled in BigInt so a 64-bit id survives, then
    // narrowed only when it is safe to — a silently rounded integer is a wrong value.
    let v = 0n
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(u8[at + i])
    const bits = BigInt(len * 8)
    if (v >= 1n << (bits - 1n)) v -= 1n << bits
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v
  }
  if (t === 7) return dv.getFloat64(at, false)
  const len = sizeOfSerial(t)
  const bytes = u8.subarray(at, at + len)
  return t % 2 === 0 ? bytes : decoder.decode(bytes)
}

/** Column names out of a CREATE TABLE statement — enough for the shapes SQLite itself emits. */
export function columnsOf(sql) {
  const open = String(sql || '').indexOf('(')
  if (open < 0) return []
  const body = String(sql).slice(open + 1, String(sql).lastIndexOf(')'))
  const parts = []
  let depth = 0, cur = '', quote = ''
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === '`' || ch === "'") { quote = ch === '`' ? '`' : ch; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  const CONSTRAINT = /^(constraint|primary|unique|check|foreign|key)\b/i
  return parts
    .map(p => p.trim())
    .filter(p => p && !CONSTRAINT.test(p))
    .map(p => {
      const m = p.match(/^["`[]?([A-Za-z_][\w$]*)["`\]]?/)
      return m ? m[1] : null
    })
    .filter(Boolean)
}

/**
 * Open a SQLite database held in memory.
 *
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{ tables: Array<{name:string, columns:string[], rootpage:number}>, rows: (name:string, limit?:number) => object[] }}
 * @throws {Error} 'not-sqlite' when the magic header is missing.
 */
export function openSqlite(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (new TextDecoder('latin1').decode(u8.subarray(0, 16)) !== MAGIC) throw new Error('not-sqlite')

  // Offset 16: page size. The value 1 means 65536, which does not fit the 2-byte field.
  const rawPageSize = dv.getUint16(16, false)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) throw new Error('bad page size')
  const reserved = u8[20]                      // per-page bytes reserved at the end
  const usable = pageSize - reserved
  const encoding = dv.getUint32(56, false)     // 1 UTF-8, 2 UTF-16le, 3 UTF-16be
  const decoder = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8')
  const pageCount = Math.floor(u8.length / pageSize)

  const pageAt = n => {
    if (n < 1 || n > pageCount) throw new Error(`page ${n} out of range`)
    return (n - 1) * pageSize
  }

  /** Reassemble a cell payload, following the overflow chain when the row does not fit. */
  function payloadOf(start, total) {
    const X = usable - 35                       // max local payload for a table leaf
    if (total <= X) return u8.subarray(start, start + total)
    // The split point is chosen so that overflow pages stay reasonably full.
    const M = Math.floor(((usable - 12) * 32) / 255) - 23
    const K = M + ((total - M) % (usable - 4))
    const local = K <= X ? K : M
    const out = new Uint8Array(total)
    out.set(u8.subarray(start, start + local), 0)
    let at = local
    let next = dv.getUint32(start + local, false)
    const seen = new Set()
    while (next && at < total) {
      if (seen.has(next)) throw new Error('overflow loop')
      seen.add(next)
      const off = pageAt(next)
      const take = Math.min(usable - 4, total - at)
      out.set(u8.subarray(off + 4, off + 4 + take), at)
      at += take
      next = dv.getUint32(off, false)
    }
    if (at < total) throw new Error('overflow truncated')
    return out
  }

  /** Decode one record (SQLite's "serial" format) into an array of values. */
  function readRecord(bytes, rowid) {
    const rdv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const [hdrLen, n] = vnum(bytes, 0)
    const types = []
    let at = n
    while (at < hdrLen) { const [t, k] = vnum(bytes, at); types.push(Number(t)); at += k }
    const values = []
    let body = hdrLen
    for (const t of types) {
      values.push(readSerial(rdv, bytes, body, t, decoder))
      body += sizeOfSerial(t)
    }
    // An INTEGER PRIMARY KEY column is stored as NULL and carries the rowid instead.
    return { values, rowid }
  }

  /** Walk a table b-tree from `root`, collecting up to `limit` records. */
  function walk(root, limit) {
    const out = []
    const seen = new Set()
    const stack = [root]
    while (stack.length && out.length < limit) {
      const page = stack.pop()
      if (seen.has(page)) continue             // a corrupt file must not spin forever
      seen.add(page)
      const off = pageAt(page)
      const hdr = page === 1 ? off + 100 : off  // page 1 carries the 100-byte file header
      const type = u8[hdr]
      if (type !== PAGE_LEAF_TABLE && type !== PAGE_INTERIOR_TABLE) continue
      const nCells = dv.getUint16(hdr + 3, false)
      const cellPtrBase = hdr + (type === PAGE_INTERIOR_TABLE ? 12 : 8)
      if (type === PAGE_INTERIOR_TABLE) {
        stack.push(dv.getUint32(hdr + 8, false)) // right-most pointer
        for (let i = 0; i < nCells; i++) {
          const cell = off + dv.getUint16(cellPtrBase + i * 2, false)
          stack.push(dv.getUint32(cell, false))
        }
        continue
      }
      for (let i = 0; i < nCells && out.length < limit; i++) {
        const cell = off + dv.getUint16(cellPtrBase + i * 2, false)
        const [total, a] = vnum(u8, cell)
        const [rowid, b] = vnum(u8, cell + a)
        out.push(readRecord(payloadOf(cell + a + b, total), rowid))
      }
    }
    return out
  }

  // sqlite_master always lives on page 1: type, name, tbl_name, rootpage, sql
  const master = walk(1, 5000)
    .map(r => ({ type: r.values[0], name: r.values[1], rootpage: Number(r.values[3]), sql: r.values[4] }))
    .filter(r => r.type === 'table' && r.rootpage > 0)

  const tables = master.map(t => ({ name: String(t.name), columns: columnsOf(t.sql), rootpage: t.rootpage }))

  return {
    tables,
    /** Rows of one table as `{column: value}` objects. Unknown table -> []. */
    rows(name, limit = 200000) {
      const t = tables.find(x => x.name.toLowerCase() === String(name).toLowerCase())
      if (!t) return []
      return walk(t.rootpage, limit).map(({ values, rowid }) => {
        const o = {}
        t.columns.forEach((c, i) => { o[c] = values[i] === null && /^(id|_id|rowid)$/i.test(c) ? rowid : values[i] })
        o._rowid = rowid
        return o
      })
    },
  }
}

/** True if the bytes begin with the SQLite magic string. */
export function looksLikeSqlite(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return u8.length > 16 && new TextDecoder('latin1').decode(u8.subarray(0, 16)) === MAGIC
}
