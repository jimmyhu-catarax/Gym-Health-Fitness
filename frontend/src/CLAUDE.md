# Colour: a fill is not an ink

Every palette entry in `index.css` is two values, and mixing them up is the easiest mistake to
make in this codebase:

- `--x` is a **fill** — a button, a chip, the FAB, a chart stroke. It carries a label.
- `--x-ink` is the same hue as **text**, solved for 4.5:1 on the surfaces it can land on.

Use `--x-ink` for anything a person reads, `--x` for anything they look at. In the dark theme
the two are the same colour, so a mistake there looks fine and only breaks in light mode —
which is how the previous palette ended up with 127 failing contrast pairs.

`--on-acc` is the label colour on an accent fill: black in dark, white in light. One
declaration per theme, no per-accent exceptions.

`index.css.test.js` parses the real stylesheet and re-measures 21 pairs across 8 accents × 2
themes, and CI runs it on every PR. **Run the tests after touching a colour** — it is the only
thing that will catch this.

The eight accent keys (`lime sky orange violet pink red teal gold`) are persisted per profile
and synced. Renaming one silently resets somebody's saved colour; the values behind them can
change freely, the keys cannot.
