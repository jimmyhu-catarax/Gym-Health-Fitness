// The demo build is the only openGym most people ever see, so its seeded history has to
// exercise the stats it is there to show off — including the effort card, which renders as
// dashes on a history that is rated too thinly or not at all.
import { describe, it, expect } from 'vitest'
import { buildDemoState } from './demoSeed.js'
import {
  effortSummary, effortWeeks, effortHistogram, hasEffort, displayScale, avgRir,
  rirOf, isHardSet, MIN_RATED, HARD_RIR
} from './effort.js'
import { effortOf, modeOf } from './history.js'
import { dailyLoad, sessionLoad } from './session-load.js'
import { morningBrief } from './brief.js'
import { trendDetail } from './trends.js'

const S = buildDemoState()
const eachSet = fn => S.workouts.forEach(w => w.entries.forEach(e => e.sets.forEach(s => fn(s, w, e))))
const sum = effortSummary(S, 0)   // 0 = the whole history

describe('demo seed — effort', () => {
  it('rates enough of the history to clear every guard in the effort stats', () => {
    expect(hasEffort(S)).toBe(true)
    expect(sum.done).toBeGreaterThan(400)
    expect(sum.rated).toBeGreaterThan(MIN_RATED * 20)
    expect(sum.avg).not.toBeNull()
    expect(sum.hardPct).not.toBeNull()
    // Somewhere between "everything is a grinder" and "nothing ever gets close".
    expect(sum.hardPct).toBeGreaterThan(0.3)
    expect(sum.hardPct).toBeLessThan(0.9)
  })

  it('leaves coverage partial, because that is the normal case the UI states a denominator for', () => {
    const cov = sum.rated / sum.done
    expect(cov).toBeGreaterThan(0.7)
    expect(cov).toBeLessThan(0.95)
  })

  it('never rates a set that has no reps to leave in the tank', () => {
    eachSet((s, w, e) => {
      if (rirOf(s) != null) expect(modeOf({ ...(e.target || {}), id: e.id })).toBe('reps')
    })
  })

  it('leaves one exercise unrated throughout, so the per-exercise Effort toggle is absent for it', () => {
    const rated = {}
    eachSet((s, w, e) => { rated[e.id] = (rated[e.id] || 0) + (rirOf(s) != null ? 1 : 0) })
    const ids = Object.keys(rated)
    expect(ids.filter(id => rated[id] === 0)).toEqual(['0605'])
    // …while the rest carry enough rated sessions for a curve of their own (needs 3).
    ids.filter(id => id !== '0605').forEach(id => {
      const sessions = S.workouts.filter(w => {
        const en = w.entries.find(e => e.id === id)
        return en && avgRir(en.sets.filter(s => s.done)) != null
      })
      expect(sessions.length).toBeGreaterThanOrEqual(3)
    })
  })

  it('labels the aggregates in the scale the profile logs', () => {
    expect(effortOf(S)).toBe('rir')
    expect(displayScale(S)).toBe('rir')
    // The oldest block is written in RPE, as if imported — the stats have to average the mix.
    let rir = 0, rpe = 0
    eachSet(s => { if (s.rir != null) rir++; else if (s.rpe != null) rpe++ })
    expect(rir).toBeGreaterThan(0)
    expect(rpe).toBeGreaterThan(0)
  })

  it('draws a weekly trend with a point for every week of the history', () => {
    const wks = effortWeeks(S, 0)
    expect(wks.length).toBeGreaterThanOrEqual(10)
    wks.forEach(w => { expect(w.n).toBeGreaterThanOrEqual(2); expect(w.sets).toBeGreaterThanOrEqual(w.n) })
    // Sorted oldest first, one point per calendar week.
    expect(wks.map(w => w.t)).toEqual([...wks.map(w => w.t)].sort((a, b) => a - b))
    expect(new Set(wks.map(w => w.t)).size).toBe(wks.length)
  })

  it('makes the deload visible as a genuinely easier week', () => {
    const wks = effortWeeks(S, 0)
    const easiest = wks.reduce((a, b) => (b.rir > a.rir ? b : a))
    const rest = wks.filter(w => w !== easiest)
    const restAvg = rest.reduce((a, w) => a + w.rir, 0) / rest.length
    expect(easiest.rir - restAvg).toBeGreaterThan(1)      // a step, not noise
    // and the blocks around it grind toward failure rather than sitting flat
    const hardest = wks.reduce((a, b) => (b.rir < a.rir ? b : a))
    expect(easiest.rir - hardest.rir).toBeGreaterThan(1.5)
    expect(hardest.t).toBeGreaterThan(easiest.t)          // the deepest week comes after it
  })

  it('spreads across the scale instead of piling onto one bucket', () => {
    const hist = effortHistogram(S, 0)
    expect(hist.reduce((n, b) => n + b.n, 0)).toBe(sum.rated)
    expect(hist.filter(b => b.pct > 0.05).length).toBeGreaterThan(2)
    expect(Math.max(...hist.map(b => b.pct))).toBeLessThan(0.6)
    // both ends occupied: sets taken to (or near) failure and sets left well short of it
    expect(hist[0].n + hist[1].n).toBeGreaterThan(0)
    expect(hist[hist.length - 1].n).toBeGreaterThan(0)
  })

  it('has hard sets to filter the muscle map by', () => {
    let hard = 0
    eachSet(s => { if (isHardSet(s)) hard++ })
    expect(hard).toBe(sum.hard)
    expect(hard).toBeGreaterThan(50)
    eachSet(s => { if (isHardSet(s)) expect(rirOf(s)).toBeLessThanOrEqual(HARD_RIR) })
  })

  it('is deterministic — two builds produce the same ratings', () => {
    const b = buildDemoState()
    const flat = st => st.workouts.map(w => w.entries.map(e => e.sets.map(s => `${s.w}x${s.r}/${s.rir ?? ''}/${s.rpe ?? ''}`).join(',')).join('|')).join(';')
    expect(flat(b)).toBe(flat(S))
  })
})

describe('demo physiology', () => {
  const S = buildDemoState()

  it('seeds a metrics series, so the Whoop half is visible without an import', () => {
    // Without this the demo shows every recovery surface in its empty state, and the feature
    // is invisible to anyone trying the app on a phone.
    expect(S.metrics.length).toBeGreaterThan(80)
    expect(S.metrics[0]).toHaveProperty('recovery')
    expect(S.metrics[0]).toHaveProperty('sleepDur')
    expect(S.metrics[0]).toHaveProperty('strain')
  })

  it('keeps one row per day, sorted, like a real import', () => {
    const dates = S.metrics.map(m => m.d)
    expect(dates).toEqual([...dates].sort())
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('keeps every value inside its physiological range', () => {
    for (const m of S.metrics) {
      expect(m.recovery).toBeGreaterThanOrEqual(1)
      expect(m.recovery).toBeLessThanOrEqual(100)
      expect(m.strain).toBeGreaterThanOrEqual(0)
      expect(m.strain).toBeLessThanOrEqual(21)
      expect(m.hrv).toBeGreaterThan(0)
      expect(m.rhr).toBeGreaterThan(25)
    }
  })

  it('keeps the sleep arithmetic self-consistent, as a real export would', () => {
    for (const m of S.metrics) expect(m.light + m.deep + m.rem).toBe(m.sleepDur)
  })

  it('actually correlates recovery with training, which is what the card exists to show', () => {
    // Seeding independent noise would demonstrate the opposite of the point: the Training &
    // recovery card is there to surface a relationship, so the demo has to contain one.
    const trained = new Set(S.workouts.map(w => w.d))
    const after = [], rested = []
    for (let i = 1; i < S.metrics.length; i++) {
      (trained.has(S.metrics[i - 1].d) ? after : rested).push(S.metrics[i].recovery)
    }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length
    expect(after.length).toBeGreaterThan(10)
    expect(rested.length).toBeGreaterThan(10)
    expect(mean(after)).toBeLessThan(mean(rested))
  })

  it('puts more strain on days that had a session', () => {
    const trained = new Set(S.workouts.map(w => w.d))
    const on = S.metrics.filter(m => trained.has(m.d)).map(m => m.strain)
    const off = S.metrics.filter(m => !trained.has(m.d)).map(m => m.strain)
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length
    expect(mean(on)).toBeGreaterThan(mean(off))
  })
})

describe('demo lifting load', () => {
  // The demo is the only build most people see, so the load half has to be visible in it —
  // and on the better of the two bases, since the seed rates its sets and clocks its
  // sessions exactly as a real Hevy history would.
  const S = buildDemoState()

  it('scores every session, so the series is sRPE rather than the volume fallback', () => {
    const dl = dailyLoad(S.workouts)
    expect(dl.basis).toBe('srpe')
    expect(dl.rated).toBe(dl.sessions)
    expect(dl.days.length).toBe(S.workouts.length)
    expect(dl.days.every(x => x.load > 0)).toBe(true)
  })

  it('gives the detail card a lifting load to draw', () => {
    const d = trendDetail(S, { days: 90 })
    expect(d.ok).toBe(true)
    expect(d.lifting.ok).toBe(true)
    expect(d.lifting.balance.ok).toBe(true)
    expect(d.lifting.weekly.length).toBeGreaterThan(4)
  })

  it('keeps the lifting load and the Whoop strain as separate numbers', () => {
    // Different units. If these ever come out equal something has started adding them.
    const d = trendDetail(S, { days: 90 })
    expect(d.load.ok).toBe(true)
    expect(d.lifting.balance.acute).not.toBe(d.load.acute)
  })

  it('puts a deload week below the block around it, which is what the ratio reads', () => {
    const byWeek = trendDetail(S, { days: 90 }).lifting.weekly.filter(w => w.days >= 3)
    const totals = byWeek.map(w => w.total)
    expect(Math.min(...totals)).toBeLessThan(Math.max(...totals) * 0.9)
  })

  it('reads a session load straight off a workout', () => {
    const w = S.workouts[S.workouts.length - 1]
    expect(sessionLoad(w)).toBeGreaterThan(0)
  })

  it('gives the home screen all three of this morning\u2019s numbers', () => {
    // The demo runs the metrics up to today, so the strip should be fully populated rather
    // than sitting in its stale state — that state is what a visitor would see if the seed
    // ever stopped at yesterday.
    const b = morningBrief(S)
    expect(b.has).toBe(true)
    expect(b.any).toBe(true)
    expect(b.recovery).not.toBeNull()
    expect(b.sleep.dur).toBeGreaterThan(0)
    expect(b.strain.value).toBeGreaterThan(0)
    expect(b.recovery.src).toBe('whoop')
  })
})
