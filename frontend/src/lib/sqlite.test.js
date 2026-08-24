import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqlite, looksLikeSqlite, columnsOf } from './sqlite.js'

// Every fixture here is a real database written by SQLite itself, not bytes we made up.
// A reader tested against its own idea of the format proves nothing; the point is that it
// agrees with the engine that will have written the file on somebody's phone.
let dir
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'sqlite-test-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

let n = 0
function build(fn, pragmas = []) {
  const path = join(dir, `db${n++}.sqlite`)
  const db = new DatabaseSync(path)
  for (const p of pragmas) db.exec(p)
  fn(db)
  db.close()
  return readFileSync(path)
}

describe('openSqlite', () => {
  it('reads a table back exactly as it was written', () => {
    const bytes = build(db => {
      db.exec('CREATE TABLE weight (id INTEGER PRIMARY KEY, time INTEGER, kg REAL, note TEXT)')
      const ins = db.prepare('INSERT INTO weight (time, kg, note) VALUES (?, ?, ?)')
      ins.run(1709769600000, 78.4, 'morning')
      ins.run(1709856000000, 78.1, null)
    })
    const db = openSqlite(bytes)
    expect(db.tables.map(t => t.name)).toContain('weight')
    const rows = db.rows('weight')
    expect(rows).toHaveLength(2)
    expect(rows[0].time).toBe(1709769600000)
    expect(rows[0].kg).toBeCloseTo(78.4, 6)
    expect(rows[0].note).toBe('morning')
    expect(rows[1].note).toBeNull()
  })

  it('fills an INTEGER PRIMARY KEY from the rowid it aliases', () => {
    // SQLite stores that column as NULL in the record and keeps the value as the rowid.
    // Reading the record naively yields null for every id.
    const bytes = build(db => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      db.prepare('INSERT INTO t (v) VALUES (?)').run('first')
    })
    const [row] = openSqlite(bytes).rows('t')
    expect(row.id).toBe(1)
    expect(row.v).toBe('first')
  })

  it('reads a table too big for one page, across the b-tree interior nodes', () => {
    // ~5k rows forces interior pages, so this covers the descent, not just a single leaf.
    const bytes = build(db => {
      db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, v INTEGER)')
      const ins = db.prepare('INSERT INTO big (v) VALUES (?)')
      // One transaction: 5000 implicit ones spend the whole test budget on fsync.
      db.exec('BEGIN')
      for (let i = 0; i < 5000; i++) ins.run(i * 3)
      db.exec('COMMIT')
    })
    const rows = openSqlite(bytes).rows('big')
    expect(rows).toHaveLength(5000)
    const vs = rows.map(r => r.v).sort((a, b) => a - b)
    expect(vs[0]).toBe(0)
    expect(vs[4999]).toBe(14997)
  })

  it('follows an overflow chain for a value larger than a page', () => {
    const long = 'x'.repeat(40000)
    const bytes = build(db => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT, tail TEXT)')
      db.prepare('INSERT INTO t (blob, tail) VALUES (?, ?)').run(long, 'after')
    })
    const [row] = openSqlite(bytes).rows('t')
    expect(row.blob).toHaveLength(40000)
    expect(row.blob).toBe(long)
    expect(row.tail).toBe('after')       // the column after the overflow must still line up
  })

  it('keeps integers exact, including negatives and 64-bit values', () => {
    const bytes = build(db => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
      const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
      for (const v of [0, 1, -1, 127, -128, 32767, -32768, 2147483647, -2147483648, 1709769600000]) ins.run(v)
      ins.run(9223372036854775807n)      // int64 max — past what a double can hold
    })
    const vs = openSqlite(bytes).rows('t').map(r => r.v)
    expect(vs.slice(0, 10)).toEqual([0, 1, -1, 127, -128, 32767, -32768, 2147483647, -2147483648, 1709769600000])
    // Too large to be a safe Number, so it must come back wide rather than rounded.
    expect(vs[10]).toBe(9223372036854775807n)
  })

  it('reads a database with a non-default page size', () => {
    const bytes = build(db => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hello')
    }, ['PRAGMA page_size = 16384'])
    expect(openSqlite(bytes).rows('t')[0].v).toBe('hello')
  })

  it('sees every table in the database', () => {
    const bytes = build(db => {
      db.exec('CREATE TABLE alpha (id INTEGER PRIMARY KEY, a TEXT)')
      db.exec('CREATE TABLE beta (id INTEGER PRIMARY KEY, b REAL)')
      db.exec('CREATE INDEX idx_a ON alpha(a)')     // an index is not a table
    })
    const names = openSqlite(bytes).tables.map(t => t.name)
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
    expect(names).not.toContain('idx_a')
  })

  it('returns nothing for a table that is not there', () => {
    const bytes = build(db => { db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)') })
    expect(openSqlite(bytes).rows('nope')).toEqual([])
  })

  it('reads blob columns as bytes', () => {
    const bytes = build(db => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)')
      db.prepare('INSERT INTO t (b) VALUES (?)').run(new Uint8Array([1, 2, 3, 250]))
    })
    const [row] = openSqlite(bytes).rows('t')
    expect(Array.from(row.b)).toEqual([1, 2, 3, 250])
  })

  it('rejects something that is not a database', () => {
    expect(() => openSqlite(new TextEncoder().encode('Date,Weight\n2024-01-01,80\n'))).toThrow('not-sqlite')
  })

  it('honours a row limit instead of reading a whole phone backup', () => {
    const bytes = build(db => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
      const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
      db.exec('BEGIN')
      for (let i = 0; i < 900; i++) ins.run(i)
      db.exec('COMMIT')
    })
    expect(openSqlite(bytes).rows('t', 50).length).toBeLessThanOrEqual(50)
  })
})

describe('looksLikeSqlite', () => {
  it('recognises a database and nothing else', () => {
    const bytes = build(db => { db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)') })
    expect(looksLikeSqlite(bytes)).toBe(true)
    expect(looksLikeSqlite(new TextEncoder().encode('Date,Weight\n'))).toBe(false)
    expect(looksLikeSqlite(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(false)
  })
})

describe('columnsOf', () => {
  it('reads column names off a CREATE TABLE', () => {
    expect(columnsOf('CREATE TABLE weight (id INTEGER PRIMARY KEY, time INTEGER, kg REAL)'))
      .toEqual(['id', 'time', 'kg'])
  })
  it('is not confused by a type with its own parentheses', () => {
    expect(columnsOf('CREATE TABLE t (a VARCHAR(255), b DECIMAL(10, 2), c TEXT)'))
      .toEqual(['a', 'b', 'c'])
  })
  it('skips table constraints, which are not columns', () => {
    expect(columnsOf('CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b), FOREIGN KEY (b) REFERENCES u(id))'))
      .toEqual(['a', 'b'])
  })
  it('handles quoted identifiers', () => {
    expect(columnsOf('CREATE TABLE t ("start time" INTEGER, `weight kg` REAL, [note] TEXT)'))
      .toEqual(['start', 'weight', 'note'])
  })
  it('agrees with SQLite on a real schema', () => {
    // The parser only has to cope with what SQLite itself round-trips, so ask it.
    const bytes = build(db => {
      db.exec('CREATE TABLE weight_record_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'app_info_id INTEGER NOT NULL, time_millis INTEGER NOT NULL, zone_offset INTEGER, ' +
        'weight REAL NOT NULL, FOREIGN KEY (app_info_id) REFERENCES application_info_table(row_id))')
    })
    const t = openSqlite(bytes).tables.find(x => x.name === 'weight_record_table')
    expect(t.columns).toEqual(['row_id', 'app_info_id', 'time_millis', 'zone_offset', 'weight'])
  })
})
