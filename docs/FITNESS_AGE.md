# Fitness age

**Stats → Fitness age.** Reads your cardiorespiratory fitness back as an age, by comparing
your VO2max with population averages for each age band. If a 40-year-old has the VO2max of
an average 30-year-old, their fitness age is 30.

## What this is, and what it is not

It is a **fitness estimate**. It says one thing: where your aerobic capacity sits against
the population curve for your age and sex.

It is **not a biological age** in the clinical sense. Those come from epigenetic clocks
(Horvath, GrimAge) or blood-biomarker panels (Levine's PhenoAge), and nothing in a gym log
substitutes for either. Whoop, Garmin and NTNU all ship a version of this number; all of
them are the fitness kind. If a future change starts calling this "biological age", that is
a bug, not a rename.

VO2max is worth singling out because its decline with age is well measured and because it
moves with training — it is the part of ageing you can actually push back on.

## What it needs

| Input | Required | Why |
| --- | --- | --- |
| **Date of birth** | yes | there is nothing to compare against without it |
| **Reference curve** (male / female) | yes | the two population curves differ by about 25% |
| **A VO2max**, by any of the three routes below | yes | the quantity being read back as an age |
| Resting heart rate | optional | one of the three routes |
| Measured VO2max | optional | the best of the three routes |

Nothing is assumed. If an input is absent the card says which one and offers to collect it,
rather than filling in a default and showing a number built on it.

**The reference curve is asked separately from the body diagram in Settings.** That setting
picks which muscle map to draw; reading it as a statement about physiology would move a
fitness age by more than a decade without ever asking. See `store/useStore.js`.

## Where the VO2max comes from

Three routes, preferred in this order — by how directly the number was measured, not by how
flattering it is.

**1. A value you entered.** From a lab test, or a watch that reports one. A real
measurement beats anything this app can infer, so it wins outright.

**2. Your best logged run.** Daniels & Gilbert's VDOT model, applied to the hardest
qualifying run in the last 90 days. Two equations from *Oxygen Power* (1979): the oxygen
cost of running at a velocity, and the fraction of VO2max a runner can hold for a duration.

This is the **maximum** across your runs, not the average — an easy jog and a hard tempo
both land in the log and only the hard one says anything about capacity. Even so it is a
**floor**: the app cannot know whether an effort was maximal, and a submaximal run can only
understate VO2max. The card says so.

A run qualifies only if it lasted 6–180 minutes at 7–25 km/h, and only if its name reads as
running. **Cycling, rowing, walking and machine cardio are excluded on purpose.** The oxygen
cost equation is for running; 30 km/h is an ordinary bike pace and a superhuman run, and the
equation cannot tell the difference. The exclusion list is keyword-based with negatives
beating positives, because the traps all contain the word "run": the bundled catalogue has
`stationary bike run v. 3`, `wheel run` and `push to run`, and `walking on incline treadmill`
is walking, whose economy differs enough that the model does not transfer.

**3. Your resting heart rate.** The heart-rate ratio method: `VO2max = 15.3 × (HRmax /
HRrest)`, with HRmax from Tanaka. The roughest of the three — it was validated on
well-trained subjects and reads high for untrained ones — so it is used only when there is
nothing better, and it is labelled when it is.

When more than one route is available the others are still shown, under "Also". A
disagreement between two estimates is information, and hiding it behind the winner would be
the wrong call.

## The formulas, and where they come from

| Model | Used for | Source |
| --- | --- | --- |
| **HUNT3** | mean VO2peak per age band and sex; the curve that gets inverted | Loe et al. 2013 — [NTNU CERG fitness numbers](https://www.ntnu.edu/cerg/fitness-numbers) |
| **Daniels & Gilbert** | VDOT from a running distance and time | *Oxygen Power*, 1979 |
| **Uth et al.** | VO2max from the HRmax/HRrest ratio | *Eur J Appl Physiol* 93:508–509, 2004 |
| **Tanaka et al.** | HRmax = 208 − 0.7 × age | *J Am Coll Cardiol* 37:153–156, 2001 |

The HUNT3 means, from about 4,600 Norwegian adults (mL/kg/min):

| Age | 20–29 | 30–39 | 40–49 | 50–59 | 60–69 | 70+ |
| --- | --- | --- | --- | --- | --- | --- |
| **Men** | 54 | 49 | 47 | 42 | 39 | 34 |
| **Women** | 43 | 40 | 38 | 34 | 31 | 27 |

Anchored at band midpoints and interpolated between them. The curve is deliberately **not**
smoothed to a tidy "7% per decade": 35→45 falls only two points for men where 25→35 falls
five, and flattening that would be inventing data the study did not report.

## Limits worth knowing

- **Off the ends of the table the age is extrapolated**, and the card says so. A VO2max of
  70 beats the 20–29 male mean of 54, and the honest answer is "off the top of the range we
  have numbers for", not a confident 14-year-old. Ages are capped to 18–90.
- **The population is Norwegian adults.** The curve is the best public one of its kind, but
  it is one country's cohort, not a universal constant.
- **VDOT is a pseudo-VO2max**: it folds running economy in with aerobic capacity, so it is
  not interchangeable with a lab value. It moves with fitness, which is what the card reads.
- **A run can lower your displayed fitness age relative to the heart-rate estimate**, as in
  the case where a moderate run gives 48 and resting heart rate suggests 52. That is
  deliberate: the run is real effort from you, the ratio method is a formula known to read
  high, and taking whichever is larger would bias the number upward every time. Both are
  shown so you can see the gap.
- **Nothing here is medical advice**, and a fitness age is not a diagnosis. If the number
  moves sharply without a change in training, that is far more likely to be a bad resting
  heart rate reading than anything about you.

## For contributors

The whole model is pure functions in `frontend/src/lib/fitness-age.js`, tested in
`fitness-age.test.js` against the published reference points rather than against the
module's own output — a 5 km in 19:57 is VDOT 50 in Daniels' table, so that is what the test
asserts. Per `CONTRIBUTING.md`, anything that changes what the number means belongs there,
with a test beside it.
