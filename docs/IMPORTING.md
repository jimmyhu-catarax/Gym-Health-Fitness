# Importing from another app

**Settings → Data → Import from another app.** Pick the file exactly as the other app gave
it to you — a `.csv`, a `.zip`, or Apple Health's `export.xml`. Nothing is written until a
summary sheet shows you what was found: how many workouts or weigh-ins, which exercises were
matched, and whether any units are being converted. Days you already have are never
overwritten, so importing the same file twice is harmless.

## Workout logs

| App | What to export | What arrives |
| --- | --- | --- |
| **FitNotes** (Android) | Settings → Export Data → CSV | workouts, sets, reps, weight |
| **FitNotes 2** (iOS) | Settings → Export | as above, plus notes |
| **Strong** | Settings → Export Data | workouts, sets, RPE, routines |
| **Hevy** | Settings → Export Data | workouts, sets, RPE, supersets, routines |
| **Whoop** | App → More → Data Export | workouts, as cardio sessions |

Exercise names are matched against the exercise library — `Bench Press (Barbell)`,
`BB Bench` and `barbell bench press` all land on the same exercise. Anything unrecognised
becomes one of your own exercises rather than being dropped, and the summary lists them so
you can see what happened.

### Your routines come with it

Every one of these apps exports what you *did*. None of them exports what you *planned* — so
a history imported on its own used to arrive complete and half-usable: years of sessions, no
routine behind any of them, and nothing for the app to prescribe your next set from until you
had hand-rebuilt every split you already owned.

Where the file names its workouts — Hevy and Strong both write the title on every row — the
routines are read back out of the sessions. A title seen at least three times becomes a
routine, built from the exercises that appear in **most** of those sessions, in the order you
train them, with the median number of working sets and reps. Warm-up sets are left out of the
count, so four working sets behind two ramp-up sets is a routine of four. Your imported
sessions are then filed under the routine they came from.

The summary sheet lists what it rebuilt before anything is written, and rebuilt routines are
ordinary routines afterwards — edit them, delete them, put them on the week.

**A Hevy API sync does better than rebuilding.** Hevy hands over the routines themselves, so
where a key is available the real routine replaces the reconstruction and the sheet says which
you are looking at. Two things only the real ones can do:

- **Show a routine you have never trained.** A rebuild needs three sessions before it can see
  a plan, so the split you wrote last night is invisible to it — and that is the plan you most
  want on today's screen.
- **Keep what you meant.** A median over sessions says what you did. It cannot tell a plan of
  5×5 apart from five sessions that happened to average five.

Where a real routine and a rebuilt one share a name, the real one takes the rebuilt one's
place and keeps its sessions, so nothing you trained comes unstuck. A rebuilt routine Hevy no
longer has survives: your sessions still point at it, and it is still the best account of
them. A routine **already in your plan** under that name is never overwritten — yours may have
been edited here, so yours is kept and the sheet says so.

It would rather rebuild nothing than rebuild a plan you have never trained, so it refuses in
three cases, and says so:

- **Sessions with no name of their own.** FitNotes has no workout title at all, and Hevy
  titles an unnamed session by the time of day — "Morning Workout" across every split you
  train. Reading those as routines would fold your whole week into one.
- **A title seen once or twice.** That is a session, not a plan.
- **A title whose sessions have little in common** — everything logged as "Gym". If no
  exercise turns up in half the sessions, or the ones that do are a minority of what actually
  gets trained, there is no template in there to find.

Weekdays are not inferred. A rebuilt routine is not put on your week schedule until you put
it there — training days drift, and the wrong workout on today's screen is worse than none.

### A note on Whoop

Whoop measures strain and heart rate. It does not know what you lifted or how many times, so
a Whoop workout can only become a **cardio session** here: its duration, and a speed where
the row carried a distance. Strain, calories and heart rate are not imported — there is
nowhere in the app to show them. Whoop has no scale, so it brings no body weight either.

## Syncing from Hevy directly

Settings → **Sync from Hevy** pulls your workouts over Hevy's API instead of asking you to
export a file. It needs an API key from
[hevy.com/settings?developer](https://hevy.com/settings?developer), which is a **Hevy Pro**
feature — a free account cannot create one, and the CSV export above still works for everyone.

The sync is deliberately a thin layer on the file path rather than a second way in.
`lib/hevy-api.js` turns the API response into the exact CSV Hevy itself exports and hands it to
the same reader, so it inherits every guard already written for the file: exercise matching,
custom exercises for the unmatched, unit handling, warm-up marking, routine rebuilding, and the
confirm sheet that stands between the result and anything being written. A synced workout and
an exported one are the same workout.

Things worth knowing:

- **Nothing is written until you confirm it**, exactly as with a file, and day-level dedup means
  syncing twice never duplicates a day.
- **The key is saved only after a sync succeeds with it.** One Hevy has just rejected is not
  worth keeping, and silently holding it makes the next failure harder to read. *Forget key*
  clears it.
- **Your browser calls Hevy directly.** Hevy sends `access-control-allow-origin: *` and allows
  the `api-key` header, so nothing proxies through this app's Node service — it stays the
  passkey-and-push service the README describes, and your key never reaches it.
- **Your routines come across too**, from `GET /v1/routines` — the real ones, not the rebuild
  described above. If that call fails the sync still completes: the workouts are the training
  log and the routines are the plan on top of it, so a routines endpoint that 404s costs you
  the plan and not the history. The sheet says the routines could not be read, so a sync with
  no routines in it cannot be mistaken for an account that has none.
- **Every sync refetches your whole history**, up to 4000 workouts. Hevy does document an
  events endpoint for incremental sync (`GET /v1/workouts/events?since=`), and its shape is
  published: paged, newest first, carrying updates *and* deletions. Honouring a deletion means
  knowing which local workout it refers to, and the sync bridges through Hevy's own CSV export,
  which has no id column — so nothing here can currently tell which workout was deleted.
  Day-level dedup makes the refetch harmless; it just costs requests.
- **The response is read defensively.** Each field is looked up under its documented name and a
  couple of plausible spellings, then sanity-checked against its value; a response where no
  workout resolves both a time and a named exercise is refused rather than turned into an empty
  or a wrong import.

### The failure this actually guards against

A response that reads as *nothing* is easy — it gets refused and you see why. The dangerous one
is a response that reads as *almost* something: the envelope resolves, the workouts and
exercises resolve, and then `weight_kg` turns out to have been renamed, so a decade of training
imports as empty sets. No summary screen makes that obvious, because the workout count and the
dates all look right.

So every set is counted. The sync reports how many of them yielded a weight, a rep count, a
duration or a distance, and which field names it did not read at all:

- **None of them** — refused outright, with the unread field names in the message. Nothing is
  written.
- **Fewer than half** — the sync stops and shows you the coverage before the normal confirm
  sheet: *"Hevy sent 12 workouts, but only 9 of their 140 sets carried a number this could
  read"*, the per-field percentages, and the fields it did not read. You can still continue;
  it just will not happen quietly.
- **Most of them** — straight through to the usual summary, no extra step.

That list of unread field names is the useful part if this ever breaks: it is exactly what a
bug report against `lib/hevy-api.js` needs.

### What has and has not been verified

Checked against the real API: the endpoint, the `api-key` header, and the CORS headers that let
the browser call it directly.

Checked in a browser against a stubbed response, through the real UI: a good sync writes the
workout with its warm-up flags and RPEs intact and stores the key; a renamed-field response is
refused; a half-readable one raises the coverage screen. There is also a test asserting that
the same session, taken once through the API mapper and once as Hevy's own CSV export, lands
in state as byte-identical workouts — if the two ever disagree about a column, one of them is
wrong and the suite says so.

**Not checked: Hevy's actual response body**, which needs a Pro key. Everything above is built
so that a mismatch there surfaces as a refusal or a coverage warning rather than a silently
wrong log — but the first sync from a real account is still the one that proves it. Read its
summary before confirming.

## Body weight

| Source | What to export | Notes |
| --- | --- | --- |
| **Apple Health** | Health → profile → Export All Health Data | a large `export.xml`; only body-mass records are read |
| **Google Fit** | [takeout.google.com](https://takeout.google.com) → select **Fit** | drop the `.zip` in as it came |
| **Health Connect** | Settings → Health Connect → Manage data → Backup and restore → Scheduled export | `Health Connect.zip` |

### Google Fit

Google Fit's own user-data APIs are being retired, so Takeout is the way out. The archive
holds body weight in two places: a column in `Daily activity metrics`, and one datapoint per
weigh-in under `All Data`. The per-weigh-in JSON is preferred where both are present,
because the CSV only carries a daily average. Takeout writes kilograms regardless of what
your phone displayed; if your profile is set to lb, the values are converted for you and the
sheet says so.

### Health Connect

Health Connect does not export a spreadsheet — its backup is a raw SQLite database inside
`Health Connect.zip`. That file is read directly; you do not need to unpack or convert
anything.

Health Connect's schema is not published, so the importer works out which table holds your
weights and which column is the mass, and whether that mass is stored in grams, kilograms or
pounds, from the values themselves — a column only counts if 80% of its samples land in a
range a real body weight and a real date occupy. The summary sheet tells you exactly what it
decided, e.g. *"Read from weight\_record\_table.weight, stored in g."* If that line looks
wrong, cancel: nothing has been written yet. If no column survives the check you get
*"No body-weight records found in that Health Connect backup"* rather than a silent
mis-import.

## Units

The app never converts your logged numbers behind your back. On import:

- a file that states its unit is converted to your profile's unit, per row — a history
  recorded partly in lb and partly in kg comes over correctly;
- a file that states nothing is taken to already be in your unit, and the sheet says so;
- body weight from the health platforms is always metric at the source, so it is converted
  only if your profile is in lb.

## If a file is refused

- **"That file's columns aren't recognised"** — the file has no column the importer can read
  as a date plus something measured. A workout export needs a date and an exercise name.
- **"That file is empty"** — no rows under the header.
- **"That file is not a readable archive"** — the `.zip` is damaged, or encrypted with a
  password. Archives protected with a password are not supported.

Everything is parsed in your browser. No file is uploaded anywhere, on a self-hosted
instance or on the demo.
