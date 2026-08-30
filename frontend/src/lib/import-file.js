// The two decisions importFromApp has to make about a file before anything else can happen:
// how to turn its bytes into text, and whether what came back is worth showing anybody.
//
// They live here rather than inline in sheets.jsx because both are pure, both had a bug that
// unit tests could have caught, and neither is about React. The emptiness check in particular
// reached the user as a crash: it assumed every non-bodyweight result carried `workouts`, and
// a Whoop export with no workouts.csv in it does not.

/** Byte-order marks, longest first so UTF-8's three bytes are tested before any two-byte one. */
const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', skip: 3 },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', skip: 2 },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', skip: 2 },
]

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b)

/**
 * Decode a text export, honouring its byte-order mark.
 *
 * Plain `new TextDecoder().decode()` assumes UTF-8, which is right almost always and
 * catastrophic in one common case: open a CSV in Excel, "Save as → Unicode text", and you get
 * UTF-16. Decoded as UTF-8 that is not slightly wrong, it is mojibake with a NUL between
 * every character, so no header matches and a perfectly good export is refused as
 * unrecognised. The BOM says which it is; this reads it.
 *
 * The BOM is dropped rather than passed through — `parseCSV` strips a leading U+FEFF itself,
 * but only that one, and a UTF-16 mark decodes to the same character. Removing it here means
 * neither layer has to know what the other did.
 */
export function decodeText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  for (const { bytes, encoding, skip } of BOMS) {
    if (u8.length >= bytes.length && startsWith(u8, bytes)) {
      try {
        return new TextDecoder(encoding).decode(u8.subarray(skip))
      } catch {
        break   // an engine without utf-16be: fall through to UTF-8 rather than throwing
      }
    }
  }
  return new TextDecoder().decode(u8)
}

/**
 * Would this parse result write anything?
 *
 * Kind-aware, because the three results carry entirely different payloads and the old form —
 * `kind === 'bodyweight' ? !parsed.bodyweight.length : !parsed.workouts.length` — assumed
 * anything that was not body weight was workouts. A physiology-only Whoop export is neither,
 * so it read `.length` off undefined and threw, outside the try/catch, on the one path a
 * Whoop user is most likely to take.
 *
 * Unknown kinds return false: an importer added later should show its summary sheet rather
 * than be silently swallowed by a guard that has not heard of it.
 */
export function importIsEmpty(parsed) {
  if (!parsed || typeof parsed !== 'object') return true
  const len = k => (Array.isArray(parsed[k]) ? parsed[k].length : 0)
  switch (parsed.kind) {
    case 'bodyweight': return len('bodyweight') === 0
    case 'metrics': return len('metrics') === 0
    case 'workouts': return len('workouts') === 0 && len('metrics') === 0
    default: return false
  }
}

/**
 * State fields that are credentials rather than data.
 *
 * A backup gets emailed to yourself, dropped in cloud storage, kept in Downloads for a year.
 * The training history in it is the point; a live API key riding along silently is not, and
 * nobody would think to check. Restoring a backup therefore leaves the key blank and it is
 * re-entered once, which is the right trade against a credential leaking with a file the user
 * treats as harmless.
 */
export const CREDENTIAL_KEYS = ['hevyKey']

/** A copy of the state safe to write to a file the user will hand around. */
export function redactCredentials(state) {
  if (!state || typeof state !== 'object') return state
  const out = { ...state }
  for (const k of CREDENTIAL_KEYS) if (k in out) out[k] = null
  return out
}
