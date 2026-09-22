> At the start of every session, read `SESSION_SETUP.md` and follow it before doing anything else.

# Gym-Health-Fitness

A self-hosted gym, body-weight and health tracker. React 19 + Vite PWA frontend, a small
Node passkey/push API, Capacitor shells for Android/iOS, all behind `docker compose up`.

**This fork is its own product**, not a personal instance and not a staging area for upstream
PRs. It is free to diverge from openGym, which means upstream branding is *wrong here* and gets
replaced as we touch it. The links are done — every clone URL, badge, reporting path and in-app
link now points at `jimmyhu-catarax/Gym-Health-Fitness` (#4). **`website/` is the exception, and
knowing why saves a session an argument with itself:** it is upstream's marketing site, on
upstream's domain, offering an APK this build does not produce, bylined and copyrighted to
upstream's author. Its repo links were repointed because they route support traffic; the rest
cannot be *repointed*, only rewritten, and rewriting a site into someone else's identity is the
naming decision in #6. Leave it until #6 lands. None of this licenses a drive-by rewrite
anywhere else either — open an issue, do it deliberately. The prebuilt images that used to sit
in `docker-compose.yml` were upstream's; they were removed rather than replaced, so compose now
always builds this repo's code.

This file records what a session **cannot** work out by reading the code. Layout, dependencies
and the standard build commands are deliberately not here — `ls`, the manifests and `--help`
already answer those.

`CONTRIBUTING.md` is binding for code style, project layout and testing. This file defers to
it rather than paraphrasing it; where the two ever disagree, CONTRIBUTING wins.

The colour system has one trap worth knowing before you touch CSS — a fill is not an ink. It
lives in `frontend/src/CLAUDE.md`, which loads when you work in there.

## Provenance and licensing

Bootstrapped from [openGym](https://github.com/DuarteSantos8/openGym) (via the
`arvids-unavailable` fork), **AGPL-3.0**. `LICENSE` and `NOTICE.md` stay as they are, and
NOTICE's attributions are load-bearing:

- The muscle-map geometry in `frontend/src/lib/body-paths.js` is MuscleMap, **MIT** — not ours.
- The exercise names, instructions, images and GIFs come from `hasaneyldrm/exercises-dataset`
  and are **not** covered by our AGPL. They keep that dataset's own terms.

Anything derived from this codebase inherits AGPL. Don't relicense, and don't strip NOTICE.

## Hard rules

**New dependencies are a hard sell.** This is `CONTRIBUTING.md`'s rule, and it has teeth — it
is why `lib/unzip.js` and `lib/sqlite.js` exist as hand-written readers instead of JSZip and
sql.js (a megabyte of WASM for one import path). Before adding a package, check whether the
platform already does it: `DecompressionStream` inflates, `Intl` formats, `crypto.subtle`
hashes. Propose and wait; don't just install.

The same rule reaches past npm: **the backend is plain JSON files on disk by design** — README
says "no database server, no cloud dependencies". A hosted database (the Supabase MCP server is
available in some environments) is not a shortcut here, it's a violation.

**Never commit `data/` or `media/`.**

- `data/` holds the session secret, the VAPID **private** key and users' passkey credentials.
  Upstream's git history contains all three as real values, so never restore or cherry-pick a
  `data/` path from upstream. If you ever see a real secret in a diff, stop and flag it.
- `media/` is ~137 MB of third-party exercise media. `NOTICE.md` states it is not distributed
  here, and `docker compose up` / `scripts/fetch-media.sh` fetch it on first run.

Both directories keep a `.gitkeep` so the compose bind mounts stay valid. **Never regenerate
`.gitignore`** from a stock Node template — it carries these carve-outs as policy, with the
reasoning in comments. Append to it; don't replace it.

**Ask before destructive operations.** `data/` is live user state at runtime, so `rm` against
it, `docker compose down -v` (removes volumes), and any history rewrite all get confirmed
first, not assumed.

## Importing other people's training history

`lib/import-csv.js` (FitNotes, Strong, Hevy, Apple Health) and `lib/import-health.js`
(Google Fit, Health Connect, Whoop) write into someone's real training log. The stance,
which the module headers spell out:

- **A wrong column header does not throw.** It silently files a year of training under the
  wrong numbers, which is far worse than refusing the file. Where a format's headers are
  documented (Google Takeout) they are matched literally; where they are not (Whoop,
  Health Connect's schema) columns are found by keyword and sanity-checked against the
  values, and a file that does not resolve is **refused, not guessed at**.
- **Nothing is written until the user confirms.** `ImportSummary` in `sheets.jsx` shows the
  dates, counts, unit conversions and any inference made. Keep new sources on that path.
- Day-level dedup means re-importing the same file is harmless. Preserve that.

## Conventions worth knowing

- **i18n: the English source string IS the key.** `t('Import history')` needs no registration —
  untranslated locales fall back to English automatically. Only `src/locales/*.js` needs
  updating, and only if you want the translation.
- **Training logic gets a unit test.** Anything deciding what you lift next, or reading a
  logged session back, belongs in a pure helper in `src/lib` with tests beside it. Per
  CONTRIBUTING: the progression engine grew two real bugs that only a test pinned down.
- Comments explain *why*, not *what*. The existing ones are dense with rationale — match that,
  and don't strip a comment that records a decision.

## Running it

Everything npm lives in `frontend/` — there is **no root `package.json`**, so `npm test` and
`npm run build` must be run from there. The test suite needs **Node ≥ 22.5**: `sqlite.test.js`
and `import-health.test.js` build their fixtures with the built-in `node:sqlite`, which older
Node doesn't have. A CI matrix that includes Node 20 fails for that reason alone.

**`docker compose up` builds from this checkout — but reuses what it built last time.** There
are no `image:` keys any more (they named upstream's tags, and compose prefers a pullable image
over a build context, so plain `up` silently started upstream's app). The trap that replaces it
is quieter: after a `git pull`, `docker compose up -d` restarts the *old* image and nothing
errors. Pass `--build`.

In `npm run dev`, requests to `/img/*` and `/gif/*` return **502 and that is expected**: Vite
proxies them to a media server that only exists once the media has been fetched. The app
renders fine without it.

`VITE_DEMO=1 npm run dev` boots guest mode with a seeded example history — the fastest way to
see charts, the heatmap and the workout flow with real-looking data.

## Repo state

- `main` is the deployable branch. Work happens on short-lived `feature/…` / `fix/…` branches
  and lands via PR.
- **CI runs the suite and the build** on every PR and every push to main, over Node 22 and 24
  (`.github/workflows/test.yml`). Run `cd frontend && npm test` before pushing anyway — it
  takes three seconds and saves a round trip.

## What this file is, what enforces it, and what must not arrive here

### This file holds rules, not measurements

A rule cannot go stale. A measured number can, and an always-loaded file is the worst place
to keep one — nobody re-reads it, so it quietly becomes the opposite of reality. This repo
already says that better than anyone: *a memory file that confidently states the opposite of
reality is worse than one that says nothing.* It applies here too.

So numbers live where the command that produces them lives. Test and file counts come from
`cd frontend && npm test`; the media size comes from `scripts/fetch-media.sh`; what a session
can and cannot verify comes from `.claude/hooks/session-start.sh`, which prints it on every
start. A figure quoted inside a correction — "the prebuilt images were upstream's" — is a
record of what was wrong, not a claim about now, and stays.

### Gated, or memory

| Rule | Backstop | State |
|---|---|---|
| Nothing written into `data/` or `media/img\|gif` | `scripts/check-protected-paths.sh`, CI `secrets` job, every push and PR | **gated** — verified 2026-09-22: exits 1 on a committed `data/secret.json`, 0 on this branch's own diff |
| `.gitignore` keeps its carve-outs | same script, second check | **gated** — "still carries its four protective carve-outs" |
| Training logic has a unit test | `.github/workflows/test.yml`, Node 22 and 24 | **gated** — 28 files, 1152 tests, 3.96 s locally on Node 22.22.2, 2026-09-22 |
| The build still builds | same workflow, `npm run build` | **gated** |
| `SESSION_SETUP.md` runs first, every session | `.claude/hooks/session-start.sh` | **gated** — the instruction had no executor until 2026-09-22 |
| New dependencies are a hard sell | nothing. The hook says it; nothing counts `package.json` | **memory** |
| No hosted database — JSON files on disk, by design | nothing | **memory**, and the likeliest one to fail, because a Supabase MCP server is one tool call away |
| Ask before `rm data/`, `down -v`, a history rewrite | nothing. Destruction is not diffable | **memory** |
| i18n: the English string is the key | nothing | **memory** — a missing `t()` renders fine |
| `website/` left alone until #6 | nothing | **memory** |
| AGPL, `NOTICE.md` attributions intact | nothing checks that MuscleMap or the dataset credit survived an edit | **not built** — a path check in the `secrets` job would cover it; nobody has asked |

Memory is not a weaker rule. It is a weaker control, and the column says which is which.

### Closing work

Say what you did not check. A cloud session cannot run `docker compose`, the passkey/push API,
the Capacitor shells, or anything reading real `data/` — the hook prints that list, and nothing
on it may be reported as tested. "Ran the suite, could not run Docker" is the finished report;
"tests pass" alone is a coverage claim this environment cannot make.

### Siblings, and what must not cross in

Eleven other repos share this account: Squash-Video-Analysis, JYH-Credentials-Concierge,
Dicktation, Informed-Consent-Forms, JYH-Health-and-Fitness, Maximize-Credit-Card-Benefits,
NJEE-Financial-Analysis, Stock-Screener, Trillion-Game, Dry-Eye-Tech, jimmyhumd-digital-brand.
(A twelfth, Surgery-Sensei, exists and has not been reviewed.) Good habits travel between them
and should. Three must not travel *into* here:

- **A hosted database.** Other repos reach for managed services; this one's README promises no
  database server and no cloud dependencies, and that promise is the product.
- **A prebuilt image.** `docker-compose.yml` had `image:` keys naming upstream's tags, and
  compose prefers a pullable image over a build context — plain `up` silently ran upstream's
  app. They were removed, not repointed. Never add one back.
- **A dependency because another repo uses it.** `lib/unzip.js` and `lib/sqlite.js` are
  hand-written because JSZip and sql.js were not worth a megabyte of WASM. A sibling's
  `package.json` is not a precedent.

And in the other direction: nothing from `data/` or `media/` leaves, for any sibling, ever.
