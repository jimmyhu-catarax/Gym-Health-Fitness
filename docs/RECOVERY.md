# Recovery and strain: where the numbers come from

Two derived numbers, both from published methods, both able to say what they were computed
from and to decline when they cannot. `frontend/src/lib/physiology.js` is the implementation;
this explains it.

## Imported first, computed second

Where your Whoop export carries a recovery score, that score is used unchanged. Whoop saw
beat-to-beat intervals, skin temperature and blood oxygen that this app never receives, and no
reconstruction from a daily summary improves on it.

Recovery is computed only for days the export did not score — the days after your last export,
or any period where a lapsed subscription meant Whoop stopped producing one. Every value
carries `recoverySrc`, and the cards say which you are looking at, because they are different
quantities and reading them as one series would be wrong.

## Recovery

**A percentile against your own recent baseline**, not a population norm. An HRV of 40 ms is
unremarkable for one person and alarming for another, so a population comparison would tell
most people very little. What carries information is today against your own last four weeks.

For a day with heart-rate variability *v* and resting heart rate *r*:

1. **ln(rMSSD).** Raw rMSSD is strongly right-skewed across people and across days, and a
   z-score of a skewed variable puts the mean in the wrong place. The log transform is standard
   practice in the HRV-guided-training literature for exactly that reason. One visible
   consequence: symmetry lives in *ratios*, not milliseconds — the same 15 ms drop counts for
   more than the same 15 ms rise.
2. **Two z-scores**, each against the previous 28 days: one for ln(rMSSD), one for resting
   heart rate. The baseline window ends the day *before* the day being scored — a day that
   contributes to its own baseline is compared against itself and drifts toward the middle.
3. **Combine**, weighted 0.7 HRV and 0.3 resting heart rate, with the resting-heart-rate term
   negated: a resting rate above your baseline is a cost, not a credit.
4. **Through a normal CDF**, scaled so that roughly ±2σ saturates, giving 1–99%. Never 0 or
   100: no day is certain.

When only one of the two inputs is available the result is renormalised rather than diluted, so
a profile with HRV but no resting heart rate is not permanently dragged toward 50%.

**It refuses** when the baseline is shorter than seven days, or has no variance. A z-score
against three points is arithmetic pretending to be information.

The zones follow the convention people already know: **green ≥ 67**, **yellow ≥ 34**, **red**
below that.

## Strain

**Banister TRIMP**, mapped onto the familiar 0–21 scale.

For each heart-rate sample, the fraction of heart-rate reserve above resting is weighted by
`y · e^(b·Δ)`, with *y* = 0.64 and *b* = 1.92 for men, 0.86 and 1.67 for women. The exponential
is the whole point: an easy hour and twenty hard minutes are not the same load, and a linear
time-in-zone model says they are.

The resulting TRIMP is unbounded, so it goes through `21 · (1 − e^(−TRIMP/τ))` with τ = 85 —
saturating rather than linear, so the difference between a hard day and a brutal one stays
visible instead of everything above "hard" pinning at 21. **That mapping is a fitted
convention, not a law.** Whoop's own is proprietary; these track each other because they rest
on the same physiology, and "agreeing to a point" is the honest claim.

There is also a coarse path from an average heart rate and a duration, because an imported
session gives an average and never a series. By Jensen's inequality it *understates* a variable
workout — the exponential of a mean is below the mean of exponentials — so an interval session
scores lower than it should. It is labelled rather than mixed silently with a series-derived
value, and there is a test asserting that inequality holds.

## Sources

| Model | Used for | Source |
| --- | --- | --- |
| Banister TRIMP | training load → strain | Banister & Calvert 1980; sex coefficients from Morton, Fitz-Clarke & Banister 1990 |
| rMSSD, ln transform | vagal tone | Task Force of the ESC/NASPE 1996 |
| Rolling z-score baseline | recovery | the HRV-guided-training construct, e.g. Plews et al. 2013 |
| erf | the normal CDF | Abramowitz & Stegun 7.1.26, \|error\| < 1.5e-7 |

Implemented from the published formulas, not ported from another project. `erf` is hand-written
rather than pulled from a statistics package, the same trade that produced this repo's ZIP and
SQLite readers.

## What this is not

Not a medical assessment. A low recovery score means your HRV and resting heart rate are below
your own recent normal — which happens from poor sleep, from alcohol, from a hard week, and
from the start of an illness, and this cannot tell you which. It is a number about your last
four weeks, not a diagnosis, and nothing here should be used to decide whether to see a doctor.

The app deliberately stops at reporting it. There is no suggested deload and no adjusted
target: the progression engine sets load from what you actually lifted, and two systems with
authority over the same number is worse than one. See `lib/readiness.js`.
