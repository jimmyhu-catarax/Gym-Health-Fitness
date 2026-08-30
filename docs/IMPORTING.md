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
