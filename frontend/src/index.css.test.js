// Contrast tests for the design tokens.
//
// CONTRIBUTING says anything easy to get subtly wrong and hard to verify by clicking gets a
// unit test. Colour qualifies: the previous palette had 127 failing pairs across its themes
// and accents, and every one of them looked fine to whoever added it — a ratio is not
// something an eye reports honestly. So the tokens are parsed straight out of index.css and
// re-measured here, for all 8 accents x 2 themes.
//
// This reads the real stylesheet rather than a copy of the values. A duplicate table would
// pass forever while the sheet drifted.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8')

/* ------------------------------------------------------------------ parse -- */
function blockOf(sel) {
  const i = CSS.indexOf(`${sel} {`) >= 0 ? CSS.indexOf(`${sel} {`) : CSS.indexOf(`${sel}{`)
  if (i < 0) return ''
  const open = CSS.indexOf('{', i)
  let depth = 0
  for (let j = open; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++
    else if (CSS[j] === '}' && --depth === 0) return CSS.slice(open + 1, j)
  }
  return ''
}
function declsOf(text) {
  const out = {}
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')   // a commented-out token must not win
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const ROOT = declsOf(blockOf(':root'))
const LIGHT = declsOf(blockOf(':root[data-theme="light"]'))
const ACCENTS = {}
for (const m of CSS.matchAll(/:root\[data-accent="(\w+)"\]\s*\{([^}]*)\}/g)) {
  ACCENTS[m[1]] = declsOf(m[2].endsWith(';') ? m[2] : `${m[2]};`)
}

/* --------------------------------------------------------------- resolve --- */
const hexRgb = h => {
  h = h.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
}
/** Resolve a token value to [r,g,b,a] within `scope` (the merged tokens for a theme+accent). */
function color(v, scope, depth = 0) {
  if (depth > 12) throw new Error(`var() cycle at ${v}`)
  v = String(v).trim()
  if (v === 'transparent') return [0, 0, 0, 0]
  let m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)$/)
  if (m) {
    if (scope[m[1]] !== undefined) return color(scope[m[1]], scope, depth + 1)
    if (m[2]) return color(m[2], scope, depth + 1)
    throw new Error(`unresolved ${m[1]}`)
  }
  // color-mix(in srgb, A p%, B) — the only form the sheet uses
  m = v.match(/^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/)
  if (m) {
    const a = color(m[1], scope, depth + 1), p = parseFloat(m[2]) / 100, b = color(m[3], scope, depth + 1)
    if (b[3] === 0) return [a[0], a[1], a[2], a[3] * p]           // mixed into transparent
    return [0, 1, 2].map(i => a[i] * p + b[i] * (1 - p)).concat(a[3] * p + b[3] * (1 - p))
  }
  m = v.match(/^rgba?\(([^)]+)\)$/)
  if (m) { const p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p[3] ?? 1] }
  if (v.startsWith('#')) return hexRgb(v)
  throw new Error(`cannot parse colour: ${v}`)
}

/* -------------------------------------------------------------- contrast --- */
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
const lum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
/** WCAG ratio. `base` is the opaque surface a translucent `bg` is composited onto. */
function ratio(fgv, bgv, basev, scope) {
  const base = over(color(basev, scope), [0, 0, 0])
  const bg = over(color(bgv, scope), base)
  const fg = over(color(fgv, scope), bg)
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}
const scopeFor = (theme, accent) => ({
  ...ROOT, ...(theme === 'light' ? LIGHT : {}), ...ACCENTS[accent],
})

/* ------------------------------------------------------------------ pairs -- */
// 4.5 is the AA bar for body text. 3.0 covers >=17px/600 button labels and UI shapes.
const PAIRS = [
  ['body text on bg',          'var(--label)',      'var(--bg)',        'var(--bg)',      4.5],
  ['body text on card',        'var(--label)',      'var(--surface)',   'var(--bg)',      4.5],
  ['secondary text on bg',     'var(--label-2)',    'var(--bg)',        'var(--bg)',      4.5],
  ['secondary text on card',   'var(--label-2)',    'var(--surface)',   'var(--bg)',      4.5],
  ['tertiary text on card',    'var(--label-3)',    'var(--surface)',   'var(--bg)',      4.5],
  ['sheet text',               'var(--label)',      'var(--bg-el)',     'var(--bg)',      4.5],
  ['sheet secondary text',     'var(--label-2)',    'var(--bg-el)',     'var(--bg)',      4.5],
  ['accent text on bg',        'var(--acc-ink)',    'var(--bg)',        'var(--bg)',      4.5],
  ['accent text on card',      'var(--acc-ink)',    'var(--surface)',   'var(--bg)',      4.5],
  ['accent text on surface-2', 'var(--acc-ink)',    'var(--surface-2)', 'var(--bg)',      4.5],
  ['tab label (active)',       'var(--acc-ink)',    'var(--bg-el)',     'var(--bg)',      4.5],
  ['tab label (inactive)',     'var(--label-3)',    'var(--bg-el)',     'var(--bg)',      3.0],
  ['danger text on card',      'var(--red-ink)',    'var(--surface)',   'var(--bg)',      4.5],
  ['warning text on card',     'var(--orange-ink)', 'var(--surface)',   'var(--bg)',      4.5],
  ['primary button label',     'var(--on-acc)',     'var(--acc)',       'var(--bg)',      3.0],
  ['pressed primary label',    'var(--on-acc)',     'var(--acc-2)',     'var(--bg)',      3.0],
  ['icon tile glyph',          'var(--on-acc)',     'var(--acc)',       'var(--bg)',      3.0],
  ['tinted button label',      'var(--acc-ink)',    'var(--acc-soft)',  'var(--surface)', 3.0],
  ['danger button label',      'var(--red-ink)',    'color-mix(in srgb,var(--red) 15%,transparent)',    'var(--surface)', 3.0],
  ['PR badge label',           'var(--yellow-ink)', 'color-mix(in srgb,var(--yellow) 18%,transparent)', 'var(--surface)', 4.5],
  ['missed-muscle chip',       'var(--orange-ink)', 'color-mix(in srgb,var(--orange) 16%,transparent)', 'var(--surface)', 4.5],
]

const THEMES = ['dark', 'light']
const NAMES = Object.keys(ACCENTS)

describe('design tokens', () => {
  it('defines all eight accents — the keys are persisted per profile', () => {
    // Renaming one would silently reset somebody's saved colour on next load.
    expect(NAMES.sort()).toEqual(['gold', 'lime', 'orange', 'pink', 'red', 'sky', 'teal', 'violet'])
  })

  it('gives every palette entry a fill, an ink and a pressed value, in both themes', () => {
    for (const hue of ['green', 'blue', 'orange', 'yellow', 'teal', 'purple', 'pink', 'red']) {
      for (const theme of THEMES) {
        const scope = scopeFor(theme, 'lime')
        for (const suffix of ['', '-ink', '-2']) {
          expect(() => color(`var(--${hue}${suffix})`, scope), `--${hue}${suffix} in ${theme}`).not.toThrow()
        }
      }
    }
  })
})

describe.each(THEMES)('contrast — %s theme', theme => {
  describe.each(NAMES)('accent %s', accent => {
    const scope = scopeFor(theme, accent)
    it.each(PAIRS)('%s clears its bar', (name, fg, bg, base, min) => {
      const r = ratio(fg, bg, base, scope)
      // The message matters more than the assertion: a failure should say the measurement.
      expect(r, `${name} measured ${r}:1 in ${theme}/${accent}, needs ${min}:1`).toBeGreaterThanOrEqual(min)
    })
  })
})

describe('the ramps stay ordered', () => {
  it.each(THEMES)('%s: label > label-2 > label-3 in contrast', theme => {
    const scope = scopeFor(theme, 'lime')
    const on = tok => ratio(tok, 'var(--surface)', 'var(--bg)', scope)
    // Hierarchy is the point of a ramp. Solving each tier against the bar independently
    // can otherwise converge them onto the same value and quietly flatten it.
    expect(on('var(--label)')).toBeGreaterThan(on('var(--label-2)'))
    expect(on('var(--label-2)')).toBeGreaterThan(on('var(--label-3)'))
  })

  // The two themes do NOT have the same shape, and asserting one ramp for both is wrong.
  // Dark runs monotonically lighter: the page is the floor and every surface rises off it.
  // Light follows the platform convention instead — a grey page, white cards raised above
  // it, and progressively darker greys for recessed controls (a segmented track, a switch
  // in its off state). So the invariant is not "monotonic", it is: a card is separable from
  // the page, and the control fills step consistently away from the card.
  it.each(THEMES)('%s: a card is separable from the page it sits on', theme => {
    const scope = scopeFor(theme, 'lime')
    const L = tok => lum(over(color(tok, scope), [0, 0, 0]))
    expect(Math.abs(L('var(--surface)') - L('var(--bg)'))).toBeGreaterThan(0.004)
  })

  it('dark: every surface rises off the page', () => {
    const scope = scopeFor('dark', 'lime')
    const L = tok => lum(over(color(tok, scope), [0, 0, 0]))
    const ramp = ['--bg', '--bg-el', '--surface', '--surface-2', '--surface-3'].map(t => L(`var(${t})`))
    for (let i = 1; i < ramp.length; i++) expect(ramp[i], `step ${i}`).toBeGreaterThan(ramp[i - 1])
  })

  it('light: cards are the lightest, control fills recede from them', () => {
    const scope = scopeFor('light', 'lime')
    const L = tok => lum(over(color(tok, scope), [0, 0, 0]))
    expect(L('var(--surface)')).toBeGreaterThan(L('var(--bg)'))
    expect(L('var(--surface-2)')).toBeLessThan(L('var(--bg)'))
    expect(L('var(--surface-3)')).toBeLessThan(L('var(--surface-2)'))
  })
})
