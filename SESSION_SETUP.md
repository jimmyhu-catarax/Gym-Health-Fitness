# Session setup — run first, every session

This project is worked on from several machines and from the web and desktop apps. Nothing
carries over between sessions except this repo: connectors, plugins and skills all reset. So
the environment gets rebuilt from what's checked in, at the start of every session.

1. **Read the state.** `CLAUDE.md`, this file, then `git log --oneline -10`, `git status`,
   `git branch -a`, and the open PRs and issues. **Reconcile the Environment Record below
   against them.** Git and GitHub are the truth; the Record is a cache, and a cache that
   disagrees with reality gets corrected, not trusted.
2. **Summarize where we left off** in a few lines: last session's work, branch and PR state,
   the next intended step.
3. **Connectors and skills are pre-assessed** in the Record's static section — don't re-derive
   them. Raise one only if *this* session's task needs something the Record doesn't list.
   Connectors are toggled manually in the app; ask, then wait. Propose a new project skill only
   once a pattern has actually recurred.
4. **Say "environment ready"** in one line, naming the branch and the next step.

**Before ending a session:** update the Record's dynamic section and commit it. A stale record
is worse than none — it misleads with authority, which ad-hoc rediscovery at least doesn't.

## Model routing

- **Strategist** (architecture, trade-offs, planning): prefer Fable, possibly as a subagent.
- **Complex execution** (non-trivial implementation, debugging, refactors): prefer Opus.
- **Mechanical** (boilerplate, renames, formatting): whatever is fast.
- **When the preferred model is unavailable** — overloaded, 529, timing out — retry once, then
  get on with the work using the best model available. Say that you downshifted and why.
  Routing is a quality preference; it must never become a reason work stops. If a
  strategy-tier decision (an architectural or irreversible one) got made while downshifted,
  note it in the Record so it can be revisited.

## Working style

- Explain reasoning before large changes. For anything large or irreversible, state the plan
  in the PR or the issue before implementing it.
- Ask before destructive operations (the named list is in `CLAUDE.md`).
- Readable over clever. Short status updates at natural checkpoints. Ask rather than assume.
- `CONTRIBUTING.md` governs code style, layout and testing. Follow it; don't restate it here,
  or the two copies will drift.

---

# Project Environment Record

_Last updated: 2026-08-25 (recovery & sleep card; loop running)_

## Static — only recompute when the project's needs actually change

- **Connectors.** **GitHub** — required (PRs, issues). **Context7** — occasionally useful for
  React 19 / Vite / Capacitor API checks. **PubMed / PubCrawl** — only if evidence-based
  training content ever becomes a feature (citing 1RM or progression literature); not needed
  for current work. **Google Drive/Gmail, FMP, SEC EDGAR, CMS Coverage/ICD-10, Clinical
  Trials** — not relevant to a self-hosted gym tracker; listing them each session is pure
  token spend. **Supabase** — present in some environments and **off-limits**: the README
  promises no database server and no cloud dependencies, and the backend is JSON files on
  disk. Reaching for it breaks a product promise, not just a preference.
- **Plugins / skills required:** none. One candidate if the importers keep growing: an
  `add-an-importer` skill capturing the refuse-don't-guess stance now living in module headers.
- **Traps a cold session walks into.** `npm test` at the repo root fails — there is no root
  manifest, everything npm is in `frontend/`. Tests need Node ≥ 22.5 (`node:sqlite`).
  `media/` and `data/` are absent by design, so `/img` and `/gif` 502 in dev.
  **Routing is hash-based** (`#/stats`, `#/workout`) — a plain `/stats` URL lands on Home,
  which looks like a redirect and is really a 404 falling through. Driving the app in a
  browser, set `location.hash`. The Start tab does not open the workout chooser either; it
  dives straight into the weigh-in flow, so the chooser is `#/workout` with nothing active. `docker compose
  up` without `--build` runs upstream's images. There is no Tailwind — the CSS is hand-written.
  Adding a dependency is a hard sell, and two readers were hand-rolled to avoid one.

## Dynamic — the only part that should change often

- **Last session:** the Whoop half. `lib/whoop-metrics.js` reads `sleeps.csv` and
  `physiological_cycles.csv` into the daily `S.metrics` series; `lib/physiology.js` derives
  strain (Banister TRIMP) and recovery (rolling z-score of ln rMSSD + resting HR) for the days
  Whoop did not score; `lib/metrics.js` selects it for display; a **Recovery & sleep** card in
  Stats shows it. Before that: fitness age, and `docker compose` fixed to build from source.
  **PRs #1, #2, #3, #7, #8, #9 and #11 are merged.** 793 tests.
- **Open:** issues **#4** (repo links route bug reports and security advisories to upstream),
  **#6** (product name), **#10** (whether to publish fork-owned images), **#12** (the Whoop /
  OpenStrap survey — licences, verbatim CSV schemas, API reference; *extend it, do not
  re-survey*).
- **Sleep & load detail** (`lib/trends.js`) answers the two questions a single trend line
  cannot: what your sleep is made of and whether it is shifting, and whether this week is
  heavy against your own last month. The load ratio is the acute:chronic construct and is
  reported as *load balance only* — Impellizzeri et al. (2020) showed the windows are
  mathematically coupled and the popular risk thresholds did not survive re-analysis, so a
  test asserts the band labels carry no risk language.
- **Next step:** everything buildable on data that already parses is done — trends, the
  training join, readiness on the Start screen, and `docs/WHOOP.md` as the how-to. What
  remains is **blocked on the owner, not on a session**: importing a real export (the
  fixtures are cross-corroborated but synthetic), iOS (needs a Mac), and the ingestion
  decision in #14. A session that finds nothing else to do here is correct to stop rather
  than invent scope. The import hardening from #12 is done —
  RFC 4180 was already handled by `parseCSV`, `__MACOSX` skipping is covered by a test, and
  BOM-aware decoding plus a kind-aware emptiness guard landed with `lib/import-file.js`. The
  training↔recovery cross-analysis (`lib/training-recovery.js`) has landed — it is the thing
  neither Hevy nor Whoop does alone, and what the merged interface is *for*.
- **Blocked on a decision:** BLE ingestion straight from the band. A PWA cannot drive Whoop's
  proprietary GATT (iOS Safari has no Web Bluetooth), so it means a native Capacitor plugin —
  an architectural fork and a new dependency. Not started deliberately.
- **An autonomous `/loop` is driving this**, self-paced, one reviewable increment per firing.
  Its stop-and-ask triggers are new dependencies, incompatible licences, architectural forks
  (BLE via a native Capacitor plugin vs Web Bluetooth is the canonical one), anything medical,
  and schema changes to persisted user JSON.
- **Decisions to revisit:**
  - Fork goal set to *divergent product* (2026-08-24); consequences live in #4/#6/#10.
  - Fitness age prefers a logged run over the resting-heart-rate estimate **even when the run
    reads lower**, so logging an easy run can *worsen* your displayed age. Deliberate — the
    ratio method reads high for untrained people and taking the larger number would bias
    upward every time — but counterintuitive enough that someone will file it as a bug.
  - Whoop nights are dated by **`Wake onset`**, not `Cycle start time`. A cycle runs sleep
    onset to sleep onset, so cycle-start dating shifts every recovery score a day early. If a
    number ever disagrees with the Whoop app by one day, this is why.
  - Recovery computed from HRV never overwrites a score Whoop supplied; `recoverySrc` marks
    which is which, because they are different quantities and must not be one series.
  - New strings are English-only in all 12 locales — the documented i18n fallback, not a bug.
