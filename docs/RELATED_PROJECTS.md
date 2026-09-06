# Related public projects — the reference list

A durable record of open-source projects in this app's problem space: workout trackers, workout
analytics, and exercise datasets. **Extend this file rather than re-surveying.** A session that
wants to know "has anyone solved this already, and may we use it" should be able to answer from
here without re-reading eight READMEs.

Whoop and band-ingestion projects (OpenStrap, `openwhoop`, `gowhoop`, `whoop-reader`) are
**not** here — they live in [issue #12](https://github.com/jimmyhu-catarax/Gym-Health-Fitness/issues/12),
which also carries the Whoop CSV schemas and the API v2 notes. Two records, no overlap: this
file is the training side, #12 is the band side.

## The rule that governs all of it

Taken verbatim from #12, because it is the thing sessions get wrong:

> **Methods are not copyrightable, source is.**

A published algorithm, a progression rule, or an observed file format can be implemented freely
with a citing comment. Source can only be ported under a licence compatible with ours, and
**any port adds a `NOTICE.md` entry**. This project is **AGPL-3.0-or-later** (`frontend/package.json`,
`api/package.json`), which decides what flows in:

| Their licence | Portable into our source? |
| --- | --- |
| MIT, BSD, Unlicense / public domain | ✅ with attribution + a `NOTICE.md` entry |
| GPL-3.0-or-later | ✅ — but carry any GPL §7 additional terms across with it |
| AGPL-3.0-only | ✅ — that portion is then pinned to AGPL-3.0, it cannot travel as "or later" |
| AGPL-3.0-or-later | ✅ — same licence, cleanest case |
| **No `LICENSE` file** | ❌ **All rights reserved.** Read for ideas; copy nothing, not even README prose |

Licences below were **read from each repo's `LICENSE`/`COPYING` file, not from its README badge
or its shields.io image** — verified 2026-09-06. A badge is a claim; the file is the licence, and
three entries here carry something no badge shows: LibreFit's GPL §7 additional terms, LiftShift's
`-only` (a badge reading "AGPL-3.0" will not tell you whether you may treat it as "or later"), and
the media exception sitting *below* an otherwise ordinary MIT block in `exercises-dataset`.

## Licence record

| Project | What it is | Licence (from the file) | Portable? |
| --- | --- | --- | --- |
| [`ioandev/hevy`](https://github.com/ioandev/hevy) | Claude Code agent that programs your next Hevy session | **none — no `LICENSE` file** | ❌ knowledge only |
| [`Gman0909/FitnessTrack`](https://github.com/Gman0909/FitnessTrack) | Self-hosted Node progressive-overload tracker | MIT | ✅ |
| [`aree6/LiftShift`](https://github.com/aree6/LiftShift) | Browser-local workout analytics over Hevy/Strong/Lyfta exports | **AGPL-3.0-only** | ✅, pinned to -only |
| [`LibreFitOrg/LibreFit`](https://github.com/LibreFitOrg/LibreFit) | Android workout tracker, F-Droid | GPL-3.0-or-later **+ [additional terms](https://github.com/LibreFitOrg/LibreFit/blob/main/ADDITIONAL_TERMS.md)** | ✅ with those terms |
| [`Snouzy/workout-cool`](https://github.com/Snouzy/workout-cool) | Fitness coaching platform, successor to workout.lol | MIT | ✅ |
| [`wger-project/wger`](https://github.com/wger-project/wger) | Django workout/nutrition manager, the mature incumbent | AGPL-3.0-or-later (code); **data is Creative Commons, per entry** | ✅ code; data separately |
| [`yuhonas/free-exercise-db`](https://github.com/yuhonas/free-exercise-db) | 800+ exercises as JSON + images | **Unlicense** (public domain) | ✅ freely |
| [`hasaneyldrm/exercises-dataset`](https://github.com/hasaneyldrm/exercises-dataset) | 1,324 exercises, GIFs, 10 languages | MIT **for data/code; media excepted** | ⚠️ see below — **we already ship this** |

## The two that carry a trap

### `hasaneyldrm/exercises-dataset` — the media is not MIT, and it is ours to get right

This is not a project we might one day use. It is the exercise library this app runs on:
`frontend/src/lib/exercises-data.js`, `frontend/src/instr/`, and the ~137 MB `docker compose up`
and `scripts/fetch-media.sh` pull into `media/`. `NOTICE.md` credits it and says the media
"remain under that dataset's own terms" — correct, and now those terms are on the record here:

The repo's `LICENSE` is MIT **followed by a `MEDIA EXCEPTION`**. The MIT grant covers only the
code, tooling, dataset structure and instruction text/translations. It explicitly does **not**
cover `images/` and `videos/`, which are **© Gym visual (https://gymvisual.com/)**, included
there by written permission at 180×180, and which "must retain the attribution
`© Gym visual — https://gymvisual.com/`". Its closing line is the sharp one:

> Cloning this repository does not grant you any license to the media; obtain your own from Gym visual.

Two consequences worth holding onto. **Our `NOTICE.md` does not currently name Gym visual** —
it names the dataset, which is the intermediary, not the rights holder the attribution clause
names. And our "not distributed in this repository, fetched on first run" posture is the right
shape, but it is a distribution argument, not an attribution one: the attribution is required
wherever the media is shown. Fixing `NOTICE.md` is a deliberate change to a load-bearing file,
so it is filed rather than done in passing — [#21](https://github.com/jimmyhu-catarax/Gym-Health-Fitness/issues/21),
which carries the clause verbatim and the open question it turns on: whether the attribution also
belongs on a credits screen in the running app, not only in `NOTICE.md`.

### `ioandev/hevy` — no licence at all

"Hevy AI Coach": no app, no server. A set of markdown files and Claude Code slash commands
(`/generate-next`, `/reschedule`) that read your last Hevy session over the Hevy MCP server,
compare it against the planned routine, and write the next routine back into Hevy. The whole
system is prompt and rule text — `CLAUDE.md`, `routines/`, `weights.md`.

It has **no `LICENSE` file**, so it is all rights reserved. That matters more than usual here
because its value *is* its prose: you cannot lift the wording of its progression rules into our
docs or our source. The training ideas behind them — volume before load, a cap on weight jumps,
deload on a stall — are ordinary strength-training method and were never his to own; implement
them from the method, not from his text.

Closest thing here to our own Hevy path (`lib/hevy-api.js` and the routine rebuild), and the
only one of the eight that writes *back* to Hevy. Relevant to [#17](https://github.com/jimmyhu-catarax/Gym-Health-Fitness/issues/17).

## The rest, and what each is actually good for

**`aree6/LiftShift`** — the closest thing to a peer this list has, and the most useful to read.
React 19 + TypeScript + Vite frontend, Express backend that only proxies Hevy and Lyfta; all
analytics run client-side, which is our stance too. It ingests **Hevy (login sync, Pro API key,
or CSV), Strong CSV, Lyfta (API key or CSV), Motra, and a generic column-autodetecting CSV**,
normalises exercise names across sources and dedups on merge — the same problem
`lib/import-csv.js` solves, solved independently. Its Strong notes match ours (semicolon
delimiters, quoted fields, unit-suffixed headers like `Weight (kg)`), and its known failure mode
is worth stealing as a *diagnosis*: an export in a non-English app locale produces unparseable
dates, and it says so rather than guessing — the refuse-don't-guess stance from `CLAUDE.md`,
arrived at by someone else. Feature overlap with us is real: muscle heatmaps with MEV/MRV
volume zones, plateau detection with a confidence level, per-set feedback.
AGPL-3.0-only, so code can come across — at the cost of pinning that part to -only.

**`Gman0909/FitnessTrack`** — MIT, Node + Express + React, self-hosted on a Pi or home server,
data on your own hardware. Its progression engine is the reason to look: **dynamic double
progression** (each set climbs to its rep-range ceiling, then adds load and resets) with a
**self-tuning pace** that accelerates when you beat targets and takes smaller steps when you
stall — derived purely from logged reps, with no subjective effort input. That is a direct
comparison for `src/lib/progression.js`, and MIT means the comparison can go further than
reading. One structural difference to note before borrowing: it stores in **SQLite via
`better-sqlite3`**, a native addon. Our backend is JSON files on disk by design, so its schema
travels as a data model, never as a dependency.

**`Snouzy/workout-cool`** — MIT, Next.js-era platform built by the primary contributor to the
abandoned workout.lol, with a large exercise database seeded from CSV. Useful mostly as an
exercise-taxonomy reference and as evidence of how a bigger feature surface gets organised. The
furthest of the eight from our "small, dependency-light, no database server" constraints, so
read it for data shape, not architecture.

**`wger-project/wger`** — the mature incumbent: Django, a REST API, Flutter apps on Play/App
Store/F-Droid/Flathub, Weblate translations, nutrition from Open Food Facts, multi-user gym
management. AGPL-3.0-or-later, same family as ours. Two things to take: its **REST API shape**,
which is the de-facto interchange format anything third-party integrates against, and its
**licence separation** — code AGPL, exercise/ingredient data Creative Commons per entry, docs
CC-BY-SA-4.0. If we ever accept community exercise contributions, that three-way split is the
model, and it is why the data question below is its own section.

**`LibreFitOrg/LibreFit`** — Kotlin/Android, F-Droid, privacy-first, 800+ exercises with images
and step-by-step instructions maintained **in-repo** with its own contribution guidelines
(artwork provenance is not stated in its README or CONTRIBUTING — check it before reusing any
image). GPL-3.0-or-later **plus §7 additional terms**: UI author attributions must be preserved,
and the LibreFit name and logo are withheld. Both terms travel with any port, and the second one
is a live example of the trademark-vs-code line that issue
[#6](https://github.com/jimmyhu-catarax/Gym-Health-Fitness/issues/6) is about.

## Exercise data specifically

Data licences are not code licences, and this is where a fork gets bitten. Three usable sources,
in descending order of freedom:

1. **`yuhonas/free-exercise-db` — Unlicense, public domain.** 800+ exercises as one JSON document
   per exercise against a published `schema.json`: `id`, `name`, `force`, `level`, `mechanic`,
   `equipment`, `primaryMuscles`, `secondaryMuscles`, `instructions[]`, `category`, `images[]`.
   Descended from `wrkout/exercises.json`. Public domain means no attribution obligation and no
   licence compatibility question at all — **the only source on this list with no strings**, and
   therefore the default answer if we ever need exercise data we can redistribute ourselves.
   English only, and stills rather than animations.
2. **`wger`'s exercise database — Creative Commons, per entry.** Community-contributed and
   multilingual, but the licence is recorded per entry, so it is checked per entry. Reachable
   over their API.
3. **`hasaneyldrm/exercises-dataset` — what we ship.** 1,324 exercises, instructions in 10
   languages, a GIF and a 180×180 thumbnail each. The breadth and the animations are why it was
   chosen and there is no reason to move. Just know that the media half is Gym visual's, not the
   dataset author's, and not MIT.

## How to add to this list

Same discipline as #12. For each new project: **open its `LICENSE` file and read it** (including
anything after the standard text — the media exception above sits below an otherwise ordinary
MIT block), say what the project actually is in one paragraph, and say what is reusable as
*knowledge* versus as *code*. Record projects that turn out to be useless too, with why — an
entry saying "looked, nothing here" is worth as much as a good one, and stops the next session
re-mining it.
