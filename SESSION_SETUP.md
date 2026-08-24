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

_Last updated: 2026-08-24_

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
  `media/` and `data/` are absent by design, so `/img` and `/gif` 502 in dev. `docker compose
  up` without `--build` runs upstream's images. There is no Tailwind — the CSS is hand-written.
  Adding a dependency is a hard sell, and two readers were hand-rolled to avoid one.

## Dynamic — the only part that should change often

- **Last session:** imported openGym as the base; reworked the colour system around
  fills vs. inks (127 failing contrast pairs → 0); added Google Fit / Health Connect / Whoop
  import with a dependency-free ZIP and SQLite reader; added `CLAUDE.md`, this file, and CI.
- **Open:** PR #1 (draft) `claude/opengym-design-data-import-1nij4s` → `main`. Issues: 0.
- **Next step:** merge the project-setup PR, then get PR #1 green and out of draft.
- **Decisions to revisit:** fork goal set to *divergent product* (2026-08-24) — the upstream
  branding scrub and fork-owned container images follow from it and want issues opening.
