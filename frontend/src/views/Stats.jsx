import { useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { EXIDX } from '../lib/exercises.js'
import { lastBW, streakWeeks, setLabel, modeOf, effortOf } from '../lib/history.js'
import { fmtNum, fmtDate, fmtVol, todayISO, weekKey } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { bwSheet, goalSheet, calendarSheet, workoutDetailSheet, WorkoutRow, bwDeltaColor, fitnessAgeSheet, importFromApp } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Heatmap from '../components/Heatmap.jsx'
import Icon from '../components/Icon.jsx'
import BodyMap, { BodyMapLegend } from '../components/BodyMap.jsx'
import { loadOfWorkouts, rankOf, MUSCLE_NAME } from '../lib/muscles.js'
import { e1rmSeries, best1RM } from '../lib/onerm.js'
import {
  hasEffort, displayScale, scaleName, toScale, avgRir, effortSummary, effortWeeks,
  effortHistogram, isHardSet, HARD_RIR
} from '../lib/effort.js'
import { Button, Segmented, SelectRow } from '../components/ui.jsx'
import { fitnessAgeReport, nameResolver } from '../lib/fitness-age.js'
import { metricsSummary, fmtDuration, STAGE_FILL, STAGE_NAME } from '../lib/metrics.js'

// Which muscles the training in a window actually hit — and, the point of the card,
// which ones it keeps missing. Shading is relative within the window (lib/muscles.js).
function MuscleBalance({ S }) {
  const [win, setWin] = useState(7)
  const [hard, setHard] = useState(false)
  const [sel, setSel] = useState(null)
  const now = Date.now()
  const inWin = S.workouts.filter(w =>
    win === 0 ? true
      : win === 7 ? weekKey(w.d) === weekKey(todayISO())
        : (w.start || new Date(w.d).getTime()) > now - win * 86400000)
  // Counting only the sets taken near failure turns the map from "where did the volume go"
  // into "where did the stimulus go" — a muscle can lead on sets and still never be trained
  // hard. Offered only when the window holds ratings at all, since with none the hard map
  // would just be empty and read as "you trained nothing".
  const rated = inWin.some(w => w.entries.some(e => e.sets.some(s => s.done && isHardSet(s))))
  const on = hard && rated
  const load = loadOfWorkouts(inWin, on ? isHardSet : null)
  const { worked, missed } = rankOf(load)
  const top = worked.slice(0, 4)
  const max = worked.length ? load[worked[0]] : 0
  const sets = m => Math.round((load[m] || 0) * 10) / 10

  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <h2 style={{ margin: 0 }}>{t('Muscle balance')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {on ? t('by hard sets') : t('by sets worked')}</span></h2>
      {rated && <Button size="sm" icon="flame" style={on ? { color: 'var(--yellow-ink)' } : undefined}
        onClick={() => { setHard(h => !h); setSel(null) }}>{on ? t('Hard') : t('All')}</Button>}
    </div>
    <Segmented className="seg-range" value={win} onChange={v => { setWin(v); setSel(null) }}
      options={[{ value: 7, label: t('Week') }, { value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 0, label: t('All') }]} />
    {inWin.length ? <>
      <BodyMap className="tappable" load={load} body={S.body} selected={sel}
        onMuscle={m => setSel(s => (s === m ? null : m))} />
      <BodyMapLegend />
      {sel && <div className="mrow" style={{ borderTop: 'var(--hair) solid var(--sep)', marginTop: 4, paddingTop: 10 }}>
        <span className="nm"><b>{t(MUSCLE_NAME[sel])}</b></span>
        <span className="v">{sets(sel) ? t('{0} sets', sets(sel)) : on ? t('no hard sets') : t('not trained')}</span>
      </div>}
      {!sel && top.map(m => <div key={m} className="mrow">
        <span className="nm">{t(MUSCLE_NAME[m])}</span>
        <span className="bar"><i style={{ width: Math.round(load[m] / max * 100) + '%', background: on ? 'var(--yellow)' : undefined }} /></span>
        <span className="v">{t('{0} sets', sets(m))}</span>
      </div>)}
      {missed.length > 0 && <>
        <h4 className="sec" style={{ marginTop: 12 }}>{on ? t('No hard sets in this period') : t('Not trained in this period')}</h4>
        <div className="mchips">{missed.map(m => <span key={m} className="mchip miss">{t(MUSCLE_NAME[m])}</span>)}</div>
      </>}
      {!missed.length && worked.length > 0 &&
        <div className="muted small" style={{ marginTop: 10 }}>{on
          ? t('Every muscle group got at least one hard set in this period.')
          : t('Every muscle group got some work in this period.')}</div>}
    </> : <div className="muted small">{t('No workouts in this period yet.')}</div>}
  </div>
}

// How hard the training was — the half of the picture a volume chart cannot show. Everything
// is computed in RIR (lib/effort.js) and converted to whichever scale this profile reads.
// Every number carries how much of the training it speaks for: rating is optional and off by
// default, so a partly rated history is the normal case, and an average without its
// denominator would quietly speak for sets that were never rated.
function EffortCard({ S }) {
  const [win, setWin] = useState(90)
  const kind = displayScale(S)
  const hd = scaleName(kind)
  const sum = effortSummary(S, win)
  const weeks = effortWeeks(S, win)
  const hist = effortHistogram(S, win)
  const maxBin = Math.max(1, ...hist.map(b => b.n))
  // The week's set count rides along in the tooltip, because the pair is the reading:
  // volume up with effort up is fatigue piling up, volume up with effort flat is adaptation.
  const pts = weeks.map(w => ({ t: w.t, y: toScale(kind, w.rir), note: t('{0} sets', w.sets) }))
  // Bins run hardest-first in both scales: RIR 0 and RPE 10 are the same set.
  const binLabel = b => kind === 'rpe' ? (b.tail ? '≤ 6' : String(10 - b.rir)) : (b.tail ? b.rir + '+' : String(b.rir))

  return <div className="card">
    <h2>{t('Effort')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('how close to failure')}</span></h2>
    <Segmented className="seg-range" value={win} onChange={setWin}
      options={[{ value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 365, label: '1Y' }, { value: 0, label: t('All') }]} />
    {sum.rated === 0 ? <div className="muted small">{t('No rated sets in this period.')}</div> : <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12 }}>
        <div>
          <div className="stat-v">{sum.avg == null ? '—' : fmtNum(toScale(kind, sum.avg)) + ' ' + hd}</div>
          <div className="small dim">{t('average effort')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="stat-v" style={{ color: 'var(--yellow-ink)' }}>{sum.hardPct == null ? '—' : Math.round(sum.hardPct * 100) + '%'}</div>
          <div className="small dim">{t('at {0} {1} or harder', hd, fmtNum(toScale(kind, HARD_RIR)))}</div>
        </div>
      </div>
      <div className="small dim" style={{ marginTop: 8 }}>{t('{0} of {1} finished sets rated', sum.rated, sum.done)}</div>
      {effortOf(S) === 'none' && <div className="small" style={{ color: 'var(--yellow-ink)', marginTop: 4 }}>
        {t('Effort per set is switched off — turn it on in Settings to keep rating.')}
      </div>}
      {pts.length > 1 && <>
        <h4 className="sec" style={{ marginTop: 12 }}>{t('Week by week')}</h4>
        <div className="chart"><LineChart points={pts} h={140} unit={hd} color="var(--yellow)" invert={kind === 'rir'} /></div>
      </>}
      <h4 className="sec" style={{ marginTop: 12 }}>{t('Where the sets land')}</h4>
      {hist.map(b => <div key={b.rir} className="mrow">
        <span className="nm">{hd} {binLabel(b)}</span>
        <span className="bar"><i style={{ width: Math.round(b.n / maxBin * 100) + '%', background: b.rir <= HARD_RIR ? 'var(--yellow)' : 'var(--label-3)' }} /></span>
        <span className="v">{b.n ? b.n + ' · ' + Math.round(b.pct * 100) + '%' : '—'}</span>
      </div>)}
      <div className="small dim" style={{ marginTop: 8 }}>
        {t('Most working sets belong close to failure without living there — half at the floor and half at the top average out to a healthy-looking middle.')}
      </div>
    </>}
  </div>
}

// Stats = the analytics hub: all charts, progress and history live here.
// Chronological age against the age at which your cardiorespiratory fitness would be
// average (lib/fitness-age.js).
//
// The card leads with what the number was built from, and it is not decoration: a fitness
// age inferred from one resting-heart-rate reading and one derived from a lab VO2max are
// the same number carrying wildly different weight, and the card is the only place that
// difference can be said out loud. Same reason the caveats are inline rather than behind
// an info tap — a floor presented as a measurement is the failure mode here.
function FitnessAgeCard({ S }) {
  const nameOf = useMemo(() => nameResolver(S, EXIDX), [S.customEx])
  const rep = fitnessAgeReport(S, { nameOf })

  if (!rep.ok) {
    const NEED = {
      birth: t('Your date of birth'),
      physSex: t('Which reference curve to compare against'),
      vo2: t('A VO2max — log a run of 6 minutes or more, add your resting heart rate, or enter a measured value'),
    }
    return <div className="card">
      <div className="row between"><h3>{t('Fitness age')}</h3><Icon name="figureRun" /></div>
      <div className="muted small" style={{ lineHeight: 1.5, marginTop: 4 }}>
        {t('Reads your cardiorespiratory fitness back as an age. To work it out it still needs:')}
      </div>
      <ul className="muted small" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.5 }}>
        {rep.missing.map(m => <li key={m}>{NEED[m]}</li>)}
      </ul>
      <div style={{ height: 12 }} />
      <Button variant="primary" onClick={fitnessAgeSheet}>{t('Set up fitness age')}</Button>
    </div>
  }

  const yrs = Math.abs(rep.delta)
  const same = yrs < 0.5
  const col = same ? 'var(--label)' : rep.delta < 0 ? 'var(--acc-ink)' : 'var(--red-ink)'
  const verdict = same ? t('about the same as your age')
    : fmtNum(yrs) + ' ' + (rep.delta < 0 ? t('years younger than your age') : t('years older than your age'))

  const SRC = {
    entered: t('from the VO2max you entered'),
    run: t('from your best logged run'),
    restingHr: t('estimated from your resting heart rate'),
  }
  const caveats = []
  if (rep.floor) caveats.push(t('A logged run only sets a floor — nothing here knows whether that effort was maximal, so your real VO2max may be higher.'))
  if (rep.rough) caveats.push(t('The resting-heart-rate method is the roughest of the three and reads high for untrained people. A logged run or a measured value would beat it.'))
  if (rep.extrapolated) caveats.push(t('This VO2max sits outside the range the HUNT3 study measured, so the age is extrapolated from the nearest band.'))
  if (rep.clamped) caveats.push(rep.clamped === 'young' ? t('Capped at 18 — the curve has nothing to say below that.') : t('Capped at 90 — the curve has nothing to say above that.'))

  return <div className="card">
    <div className="row between"><h3>{t('Fitness age')}</h3><Icon name="figureRun" /></div>
    <div className="row" style={{ gap: 18, alignItems: 'baseline', marginTop: 6 }}>
      <div style={{ fontSize: 44, fontWeight: 700, lineHeight: 1, color: col }}>{Math.round(rep.fitness)}</div>
      <div className="muted small" style={{ lineHeight: 1.4 }}>
        {t('Chronological age')} {Math.floor(rep.chrono)}<br />
        <span style={{ color: col }}>{verdict}</span>
      </div>
    </div>

    <div className="row between" style={{ marginTop: 14 }}>
      <span className="muted small">{t('VO2max')}</span>
      <span className="small" style={{ whiteSpace: 'nowrap' }}><b>{fmtNum(rep.vo2)}</b> <span className="muted">ml/kg/min</span></span>
    </div>
    {/* On its own line rather than inline with the value: the longest source string wraps
        the value column out of alignment with the rows under it. */}
    <div className="muted small" style={{ textAlign: 'right', marginTop: 1, lineHeight: 1.35 }}>{SRC[rep.source]}</div>
    {rep.run && rep.source === 'run' && <div className="row between" style={{ marginTop: 4 }}>
      <span className="muted small">{t('Best run')}</span>
      <span className="muted small" style={{ textAlign: 'right' }}>{fmtNum(rep.run.kmh)} km/h · {fmtNum(rep.run.min)} min · {fmtDate(rep.run.d, true)}</span>
    </div>}
    <div className="row between" style={{ marginTop: 4 }}>
      <span className="muted small">{t('Average for your age')}</span>
      <span className="muted small">{fmtNum(rep.norm)} ml/kg/min</span>
    </div>
    {rep.others.map(o => <div key={o.source} className="row between" style={{ marginTop: 4 }}>
      <span className="muted small">{t('Also')}</span>
      <span className="muted small" style={{ textAlign: 'right' }}>{fmtNum(o.vo2)} · {SRC[o.source]}</span>
    </div>)}

    {caveats.map((c, i) => <div key={i} className="muted small" style={{ marginTop: 8, lineHeight: 1.45, display: 'flex', gap: 6 }}>
      <Icon name="info" style={{ flex: '0 0 auto', marginTop: 2 }} /><span>{c}</span>
    </div>)}

    <div style={{ height: 10 }} />
    <Button variant="ghost" className="dim" onClick={fitnessAgeSheet}>{t('Edit inputs')}</Button>
  </div>
}

// The Whoop half of the interface: how recovered you are, how you slept, how hard the day
// was. Fed by S.metrics (imported) and lib/physiology.js (computed for the days Whoop did
// not score).
//
// Two things this card refuses to do, both for the same reason — an absent number and a bad
// one look identical once they reach a chart:
//
//   It never prints the newest row under "Today". An export describes the days up to when it
//   was taken, so between imports the freshest row gets older while looking exactly as fresh.
//   Every figure carries how many days back it is.
//
//   It never draws a stage breakdown whose slices do not sum to the night. That identity is
//   also the import's correctness check (see sleepBreakdown), so a broken sum means a column
//   was matched to the wrong metric, and a plausible-looking chart is the worst outcome.
const ZONE_INK = { green: 'var(--green-ink)', yellow: 'var(--yellow-ink)', red: 'var(--red-ink)' }
const ZONE_FILL = { green: 'var(--green)', yellow: 'var(--yellow)', red: 'var(--red)' }

/** "today" / "yesterday" / "3 days ago" — the age has to travel with the number. */
function Age({ days }) {
  if (days == null) return null
  const s = days === 0 ? t('today') : days === 1 ? t('yesterday') : t('{0} days ago', days)
  return <span className="dim"> · {s}</span>
}

/** A trend against your own recent baseline, coloured by whether it is good news. */
function Delta({ trend, unit = '' }) {
  if (!trend || trend.delta === 0) return null
  const col = trend.better > 0 ? 'var(--green-ink)' : trend.better < 0 ? 'var(--red-ink)' : 'var(--label-2)'
  return <span className="small" style={{ color: col }}>
    {(trend.delta > 0 ? '+' : '') + fmtNum(trend.delta)}{unit}
  </span>
}

function RecoveryCard({ S }) {
  const [range, setRange] = useState(30)
  const fileRef = useRef(null)
  const sum = useMemo(() => metricsSummary(S, { days: range }), [S.metrics, range])

  // The same hidden input Settings uses. Kept here rather than sending someone to Settings
  // and back: the empty state is the moment they want to import, and the confirm sheet in
  // sheets.jsx still stands between the file and anything being written.
  const picker = <input ref={fileRef} type="file" style={{ display: 'none' }}
    accept=".csv,.xml,.json,.zip,.db,text/csv,text/xml,application/json,application/zip"
    onChange={ev => { const f = ev.target.files[0]; if (f) importFromApp(f); ev.target.value = '' }} />

  if (!sum.ok) {
    return <div className="card">
      <div className="row between"><h3>{t('Recovery & sleep')}</h3><Icon name="heart" /></div>
      <div className="muted small" style={{ lineHeight: 1.5, marginTop: 4 }}>
        {t('Sleep, recovery and strain from your Whoop band. Export your data from the Whoop app (More → Data Export) and drop the zip in here — sleep and recovery arrive alongside your workouts.')}
      </div>
      <div style={{ height: 12 }} />
      <Button variant="primary" icon="download" onClick={() => fileRef.current?.click()}>{t('Import Whoop data')}</Button>
      {picker}
    </div>
  }

  const { recovery, sleep, strain, hrv, rhr } = sum
  const bd = sleep && sleep.breakdown

  return <div className="card">
    <div className="row between">
      <h3>{t('Recovery & sleep')}</h3>
      <Segmented className="seg-range" value={range} onChange={setRange}
        options={[{ value: 7, label: '1W' }, { value: 30, label: '1M' }, { value: 90, label: '3M' }]} />
    </div>

    {recovery && <>
      <div className="row" style={{ gap: 18, alignItems: 'baseline', marginTop: 8 }}>
        <div style={{ fontSize: 44, fontWeight: 700, lineHeight: 1, color: ZONE_INK[recovery.zone] }}>
          {Math.round(recovery.pct)}<span style={{ fontSize: 22 }}>%</span>
        </div>
        <div className="muted small" style={{ lineHeight: 1.45 }}>
          {t('Recovery')}<Age days={recovery.stale} /><br />
          <Delta trend={recovery.trend} unit="%" />
          {recovery.trend && <span className="dim"> {t('vs your {0}-day average', recovery.trend.n)}</span>}
        </div>
      </div>
      {/* Whoop saw beat-to-beat data this app never gets, so a computed score is a fallback
          and says so rather than passing for the real thing. */}
      {recovery.src === 'computed' && <div className="muted small" style={{ marginTop: 6, lineHeight: 1.4 }}>
        <Icon name="info" /> {t('Worked out from your HRV and resting heart rate against your own 28-day baseline — Whoop did not score this day.')}
      </div>}
    </>}

    <div className="row between" style={{ marginTop: 12 }}>
      {hrv && <div><div className="l muted small">{t('HRV')}</div>
        <div><b>{fmtNum(hrv.value)}</b> <span className="muted small">ms</span> <Delta trend={hrv} /></div></div>}
      {rhr && <div><div className="l muted small">{t('Resting HR')}</div>
        <div><b>{fmtNum(rhr.value)}</b> <span className="muted small">bpm</span> <Delta trend={rhr} /></div></div>}
      {strain && <div><div className="l muted small">{t('Day strain')}</div>
        <div><b>{fmtNum(strain.value)}</b> <span className="muted small">/ 21</span> <Delta trend={strain.trend} /></div></div>}
    </div>

    {sleep && sleep.dur != null && <>
      <h4 className="sec">{t('Last night')}<Age days={sleep.stale} /></h4>
      <div className="row between">
        <span><b style={{ fontSize: 20 }}>{fmtDuration(sleep.dur)}</b>
          {sleep.need && <span className="muted small"> {t('of {0} needed', fmtDuration(sleep.need))}</span>}</span>
        {sleep.perf != null && <span className="muted small">{Math.round(sleep.perf)}% {t('performance')}</span>}
      </div>
      {bd && <>
        <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', marginTop: 8, gap: 2 }}>
          {bd.stages.map(s => <div key={s.k} style={{ width: s.pct + '%', background: STAGE_FILL[s.k] }} />)}
        </div>
        <div className="row" style={{ gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
          {bd.stages.map(s => <span key={s.k} className="muted small">
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: STAGE_FILL[s.k], marginRight: 5 }} />
            {t(STAGE_NAME[s.k])} {fmtDuration(s.min)}
          </span>)}
        </div>
      </>}
    </>}

    {sum.series.recovery.length > 1 && <>
      <h4 className="sec">{t('Recovery trend')}</h4>
      <div className="chart">
        <LineChart points={sum.series.recovery} h={140} unit="%"
          color={recovery ? ZONE_FILL[recovery.zone] : 'var(--acc)'} />
      </div>
    </>}

    {sum.stale > 2 && <div className="muted small" style={{ marginTop: 8, lineHeight: 1.4 }}>
      <Icon name="info" /> {t('Your last import covers up to {0}. Import a fresh export to bring this up to date.', fmtDate(sum.latest.d, true))}
      <div style={{ height: 8 }} />
      <Button size="sm" icon="download" onClick={() => fileRef.current?.click()}>{t('Import Whoop data')}</Button>
    </div>}
    {picker}
  </div>
}

export default function Stats() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [range, setRange] = useState(90)
  const [exId, setExId] = useState(null)
  const [exMetric, setExMetric] = useState('top')
  const now = Date.now()
  const anyEffort = hasEffort(S)
  const kind = displayScale(S)
  const hd = scaleName(kind)

  const bwPts = S.bodyweight.filter(b => range === 0 || (b.t || new Date(b.d).getTime()) > now - range * 86400000)
    .map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d }))
  const bw30 = S.bodyweight.filter(b => (b.t || new Date(b.d).getTime()) > now - 30 * 86400000)
  const bwDelta30 = bw30.length > 1 ? bw30[bw30.length - 1].w - bw30[0].w : null
  const monthW = S.workouts.filter(w => w.d.slice(0, 7) === todayISO().slice(0, 7)).length

  const exHist = [...new Set(S.workouts.flatMap(w => w.entries.map(e => e.id)))].filter(id => EXIDX[id]).sort((a, b) => EXIDX[a].n < EXIDX[b].n ? -1 : 1)
  const curEx = exId && exHist.includes(exId) ? exId : exHist[0] || null
  // How this exercise was logged most recently decides what the curve means: top weight,
  // longest hold or top speed. Sets logged in another mode lack the field and score 0, so a
  // switched exercise drops its old points instead of mixing seconds into a weight chart.
  const curMode = curEx ? (() => {
    for (let i = S.workouts.length - 1; i >= 0; i--) {
      const en = S.workouts[i].entries.find(e => e.id === curEx)
      if (en) return modeOf({ ...(en.target || {}), id: curEx })
    }
    return modeOf({ id: curEx })
  })() : 'reps'
  const curCardio = curMode === 'cardio'
  const curTimed = curMode === 'time'
  const metric = s => curCardio ? (s.speed || 0) : curTimed ? (s.sec || 0) : (s.w || 0)
  const exUnit = curCardio ? 'km/h' : curTimed ? 's' : S.unit
  let exPts = [], exList = [], exBest = 0
  if (curEx) {
    S.workouts.forEach(w => {
      const en = w.entries.find(e => e.id === curEx)
      if (en) { const mx = Math.max(0, ...en.sets.filter(s => s.done).map(metric), curCardio || curTimed ? 0 : (en.topW || 0)); if (mx > 0) { exPts.push({ t: w.start, y: mx, d: w.d, sets: en.sets.filter(s => s.done), target: en.target }); if (mx > exBest) exBest = mx } }
    })
    exList = exPts.slice(-5).reverse()
  }
  // Estimated 1RM (issue #18) — only reps-mode training produces one, so cardio and timed
  // work simply have no points and the toggle stays hidden.
  const e1Pts = curEx ? e1rmSeries(S, curEx) : []
  const e1Best = curEx ? best1RM(S, curEx) : null
  const showE1 = e1Pts.length > 0
  // Effort on this exercise, per session. It rides on the top-set curve as well as having a
  // curve of its own, because the two only mean something together: the same weight moved
  // with more left in the tank is progress a weight-only chart draws as a flat line.
  const exRir = exPts.map(p => avgRir(p.sets))
  const showEff = exRir.filter(v => v != null).length >= 3
  const effPts = exPts.map((p, i) => (exRir[i] == null ? null : { t: p.t, y: toScale(kind, exRir[i]), d: p.d })).filter(Boolean)
  const onE1 = showE1 && exMetric === 'e1rm'
  const onEff = showEff && exMetric === 'effort'
  const topPts = exPts.map((p, i) => ({
    t: p.t, y: p.y, d: p.d,
    // 0 RIR (nothing left) is a full dot, 4+ a faint one; unrated sessions keep the plain line.
    m: exRir[i] == null ? null : 1 - Math.min(4, Math.max(0, exRir[i])) / 4,
    note: exRir[i] == null ? undefined : hd + ' ' + fmtNum(toScale(kind, exRir[i]))
  }))
  const exOpts = [{ value: 'top', label: t('Top set') }]
  if (showE1) exOpts.push({ value: 'e1rm', label: t('Est. 1RM') })
  if (showEff) exOpts.push({ value: 'effort', label: t('Effort') })

  return <>
    <div className="hdr"><div><h1>{t('Stats')}</h1><div className="sub">{t('Progress & history')}</div></div>
      <button className="iconbtn" onClick={() => nav('/history')} aria-label={t('History')}><Icon name="history" /></button></div>

    <div className="tiles">
      <div className="tile"><div className="l"><Icon name="dumbbell" />{t('Workouts')}</div><div className="v">{S.workouts.length}</div></div>
      <div className="tile"><div className="l"><Icon name="calendar" />{t('This month')}</div><div className="v">{monthW}</div></div>
      <div className="tile"><div className="l"><Icon name="flame" />{t('Week streak')}</div><div className="v">{streakWeeks(S)}</div></div>
      <div className="tile"><div className="l"><Icon name="scale" />{t('Weight 30d')}</div><div className="v" style={{ fontSize: 22, color: bwDelta30 === null ? 'inherit' : bwDeltaColor(bwDelta30, (lastBW(S) || {}).w || 0) }}>{bwDelta30 === null ? '—' : (bwDelta30 > 0 ? '+' : '') + fmtNum(bwDelta30) + ' ' + S.unit}</div></div>
    </div>

    <RecoveryCard S={S} />

    <FitnessAgeCard S={S} />

    <div className="card">
      <h2>{t('Activity — last 12 months')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('by time trained')}</span></h2>
      <Heatmap S={S} onDay={iso => { const ws = S.workouts.filter(w => w.d === iso); if (ws.length === 1) workoutDetailSheet(ws[0]); else if (ws.length) calendarSheet(iso) }} />
    </div>

    {S.workouts.length > 0 && <MuscleBalance S={S} />}
    {anyEffort && <EffortCard S={S} />}

    <div className="cols">
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('Body weight')}</h2>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" icon="target" style={S.targetW ? { color: 'var(--yellow-ink)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
            <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
          </div>
        </div>
        <Segmented className="seg-range" value={range} onChange={setRange}
          options={[{ value: 30, label: '1M' }, { value: 90, label: '3M' }, { value: 365, label: '1Y' }, { value: 0, label: t('All') }]} />
        <div className="chart"><LineChart points={bwPts} h={160} unit={S.unit} goal={S.targetW} /></div>
      </div>

      <div className="card">
        <h2>{t('Exercise progress')}</h2>
        {exHist.length ? <>
          <div className="sect-b" style={{ marginBottom: 10 }}>
            <SelectRow title={t('Exercise')} sheetTitle={t('Exercise progress')} value={curEx} onChange={setExId}
              options={exHist.map(id => ({ value: id, label: EXIDX[id].n }))} />
          </div>
          {exOpts.length > 1 && <Segmented className="seg-range" value={onEff ? 'effort' : onE1 ? 'e1rm' : 'top'} onChange={setExMetric} options={exOpts} />}
          <div className="chart">
            {onEff
              ? <LineChart points={effPts} h={150} unit={hd} color="var(--yellow)" invert={kind === 'rir'} />
              : <LineChart points={onE1 ? e1Pts.map(p => ({ t: p.t, y: p.y, d: p.d })) : topPts} h={150} unit={exUnit} color="var(--blue)" />}
          </div>
          <div style={{ marginTop: 8 }}>{exList.map((p, i) => <div key={i} className="row between small" style={{ padding: '6px 0', borderBottom: 'var(--hair) solid var(--sep)' }}>
            <span className="muted">{fmtDate(p.d, true)}</span><span>{p.sets.map(s => setLabel(curEx, s, p.target)).join('  ')}</span></div>)}</div>
          <div className="small dim" style={{ marginTop: 8 }}>
            {onEff ? t('Average effort per workout') : onE1 ? t('Estimated 1RM per workout') : curCardio ? t('Top speed per workout') : curTimed ? t('Longest hold per workout') : t('Best set weight per workout')}
            {onEff ? '' : <> · {t('Best:')}{' '}<b className="accent">{fmtNum(onE1 ? e1Best.est : exBest)} {onE1 ? S.unit : exUnit}</b></>}
          </div>
          {onE1 && <div className="small dim" style={{ marginTop: 4 }}>
            {t('Best estimate from {0} on {1} — an estimate, not a tested max.', fmtNum(e1Best.w) + ' ' + S.unit + ' × ' + e1Best.r, fmtDate(e1Best.d, true))}
          </div>}
          {!onEff && !onE1 && showEff && <div className="small dim" style={{ marginTop: 4 }}>
            {t('A fuller dot means less left in the tank — the same weight at a lower {0} is progress the line alone does not show.', hd)}
          </div>}
        </> : <div className="muted small">{t('Finish your first workout to see progress curves here.')}</div>}
      </div>
    </div>

    {S.workouts.length > 0 && <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h4 className="sec" style={{ margin: 0 }}>{t('Recent workouts')}</h4>
        <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={() => nav('/history')}>{t('All')} {S.workouts.length}</Button>
      </div>
      <div className="list">{[...S.workouts].reverse().slice(0, 6).map(w => <WorkoutRow key={w.id} w={w} onClick={() => workoutDetailSheet(w)} />)}</div>
    </>}
  </>
}
