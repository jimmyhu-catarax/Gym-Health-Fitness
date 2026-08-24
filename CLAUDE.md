# Gym-Health-Fitness

A self-hosted gym, body-weight and health tracker. React 19 + Vite PWA frontend, a small
Node passkey/push API, Capacitor shells for Android/iOS, all behind `docker compose up`.

This file records what a session **cannot** work out by reading the code. Layout, dependencies
and the standard build commands are deliberately not here — `ls`, the manifests and `--help`
already answer those.

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
hashes. If a dependency really is warranted, say why in the PR.

**Never commit `data/` or `media/`.**

- `data/` holds the session secret, the VAPID **private** key and users' passkey credentials.
  The upstream fork committed all three to a public repo; that is exactly the mistake
  `.gitignore` now prevents. If you ever see a real secret in a diff, stop and flag it.
- `media/` is ~137 MB of third-party exercise media. `NOTICE.md` states it is not distributed
  here, and `docker compose up` / `scripts/fetch-media.sh` fetch it on first run.

Both directories keep a `.gitkeep` so the compose bind mounts stay valid.

## Colour: a fill is not an ink

Every palette entry in `frontend/src/index.css` is two values, and mixing them up is the
easiest mistake to make in this codebase:

- `--x` is a **fill** — a button, a chip, the FAB, a chart stroke. It carries a label.
- `--x-ink` is the same hue as **text**, solved for 4.5:1 on the surfaces it can land on.

Use `--x-ink` for anything a person reads, `--x` for anything they look at. In the dark theme
the two are the same colour, so a mistake there looks fine and only breaks in light mode —
which is how the previous palette ended up with 127 failing contrast pairs.

`--on-acc` is the label colour on an accent fill: black in dark, white in light. One
declaration per theme, no per-accent exceptions.

`index.css.test.js` parses the real stylesheet and re-measures 21 pairs across 8 accents × 2
themes. **Run the tests after touching a colour** — it is the only thing that will catch this.

The eight accent keys (`lime sky orange violet pink red teal gold`) are persisted per profile
and synced. Renaming one silently resets somebody's saved colour; the values behind them can
change freely, the keys cannot.

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
`npm run build` must be run from there.

In `npm run dev`, requests to `/img/*` and `/gif/*` return **502 and that is expected**: Vite
proxies them to a media server that only exists once the media has been fetched. The app
renders fine without it.

`VITE_DEMO=1 npm run dev` boots guest mode with a seeded example history — the fastest way to
see charts, the heatmap and the workout flow with real-looking data.

## Repo state

- `main` is the deployable branch. Work happens on short-lived `feature/…` / `fix/…` branches
  and lands via PR.
- **There is no CI.** No GitHub Actions workflow exists, so nothing re-runs the test suite on a
  push or a PR. A green PR means nobody checked, not that checks passed — run
  `cd frontend && npm test` yourself before pushing.
