# Using this with your Whoop band

Your training log and your recovery data in one place. This page is the practical route from
a band on your wrist to numbers on your own screen.

You do not need a Whoop subscription for the import — the data export is available to any
account, including a lapsed one.

## 1. Get your data out of Whoop

In the Whoop app: **More → Account settings → Data export → Download my data**.

Whoop emails you a link, usually within a few minutes. What arrives is a `.zip` holding four
CSVs:

| File | What is in it |
| --- | --- |
| `physiological_cycles.csv` | recovery score, HRV, resting heart rate, day strain, energy |
| `sleeps.csv` | duration, stages, performance, efficiency, respiratory rate |
| `workouts.csv` | activities, strain per activity, heart-rate zones |
| `journal_entries.csv` | your journal answers — **not imported**, see below |

**Keep the zip as it came.** Do not unzip it, do not open the CSVs in Excel and re-save them.
Excel's "Unicode text" round-trip rewrites them as UTF-16 — that case is handled, but the
fewer transformations between Whoop and here, the fewer things can go wrong.

## 2. Run the app

**On a computer**, from a checkout:

```bash
cp .env.example .env
docker compose up -d --build
```

Then open <http://localhost:8080>. Keep the `--build`: without it Compose restarts the image
it built last time, so a `git pull` changes nothing.

**On Android**, build the APK — `docs/MOBILE.md` has the headless route, no Android Studio
needed — and sideload it.

**On iOS**, it installs as a PWA: open the site in Safari and use **Share → Add to Home
Screen**. A native build needs a Mac with Xcode; see `docs/MOBILE.md`.

## 3. Import

**Stats → Recovery & sleep → Import Whoop data**, and pick the zip. It is the same importer as
**Settings → Data → Import from another app**, so either works.

Nothing is written until you have seen what it found. The confirm sheet shows the date range,
how many days are new, and — the part worth actually reading — **a chip for every metric it
recognised**. Whoop does not publish its column names, so the importer matches them by keyword
and then checks the values are physiologically possible for what they claim to be. Those chips
are your chance to catch a column read as the wrong thing. If you see something you did not
expect, or a metric you know is in your export is missing, that is worth reporting.

Days you already have are left alone, so importing an overlapping export again is harmless and
you can re-import whenever you like.

## 4. What you get

**Stats → Recovery & sleep.** Today's recovery with HRV, resting heart rate and day strain
against your own recent baseline; last night's duration and stage breakdown; and a trend chart
you can switch between recovery, sleep, strain, HRV and resting heart rate over 1W / 1M / 3M.

**Stats → Training & recovery.** The reason to have both halves in one app: recovery the
morning after you trained versus after you rested, how much volume you actually do by the zone
you woke up in, and how strain, sleep and volume move together. Nothing is reported below 14
paired days, and every figure carries its sample size — with eight pairs you can pull a
convincing-looking correlation out of dice.

**Start workout.** A recovery strip above today's plan, when the score is fresh enough to be
about today.

That strip **tells you the number and stops there**. No suggested deload, no adjusted target.
The progression engine already sets your loads from what you actually lifted, and a second
system arguing with it would leave you unable to tell which one moved your weights. What to do
with a red morning is your call.

## 5. Keeping it current

An export is a snapshot. It describes the days up to the moment you took it and nothing after,
so between imports the newest reading gets older while looking exactly as fresh. The cards
label how old every figure is, the readiness strip disappears once its score is more than a day
old, and past two days the card offers to take a fresh import. Re-export and re-import whenever
you want it current — as often as weekly, if you look at it weekly.

## 6. What this does not do

- **No live sync.** Everything comes from an export you download and hand over. Reading the
  band directly over Bluetooth, or pulling from Whoop's API, are both real options with real
  trade-offs — [issue #14](https://github.com/jimmyhu-catarax/Gym-Health-Fitness/issues/14)
  lays them out. Neither is built.
- **Journal entries are not imported.** They are free text and yes/no answers with no obvious
  home in the model, and inventing a field to hold data nothing reads back is how a schema
  rots.
- **Sleep staging and apnea screening are not built.** Both need beat-to-beat intervals and raw
  accelerometry, which only the Bluetooth route provides. The apnea one additionally needs a
  decision about how to present a medical screening figure without it reading as a diagnosis.
- **Recovery here is not always Whoop's recovery.** Where your export has a score, that score
  is used. Where it does not — days after your last export, or a lapsed subscription — one is
  computed from your HRV and resting heart rate against your own 28-day baseline. The card says
  which you are looking at, because they are different quantities and should not be read as one
  series. `docs/RECOVERY.md` explains the model.

## 7. If something goes wrong

| What you see | What it means |
| --- | --- |
| *"That file's columns aren't recognised"* | No column resolved. If it is a genuine Whoop export, that is a bug worth reporting — attach the header line, not the file. |
| A metric you expected is missing from the chips | Its column resolved but its values failed the plausibility check, or your band does not record it (a 3.0 has no SpO2). |
| *"Nothing new to import"* | Every day in the file is already present. Expected on a re-import. |
| Recovery disagrees with the Whoop app by one day | Should not happen — a night is filed under the day you **woke up**, matching how Whoop scores it. If it is consistently off by one, report it. |
| The strip on Start workout is missing | The newest score is more than a day old. Import a fresh export. |
| Everything is empty after `docker compose up` | You left off `--build` and Compose restarted an older image. |
