> At the start of every session, read `SESSION_SETUP.md` and follow it before doing anything else.

# Gym-Health-Fitness

A self-hosted gym, body-weight and health tracker. React 19 + Vite PWA frontend, a small
Node passkey/push API, Capacitor shells for Android/iOS, all behind `docker compose up`.

**This fork is its own product**, not a personal instance and not a staging area for upstream
PRs. It is free to diverge from openGym, which means two things a session should act on rather
than tiptoe around: upstream branding is *wrong here* and gets replaced as we touch it (README
badges, `docs/SELF_HOSTING.md`'s clone URL and `SECURITY.md`'s release process still point at
`DuarteSantos8/openGym` — issue #4 tracks it). None of that licenses a drive-by rewrite —
open an issue, do it deliberately. The prebuilt images that used to sit in `docker-compose.yml`
were upstream's; they were removed rather than replaced, so compose now always builds this
repo's code.

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
