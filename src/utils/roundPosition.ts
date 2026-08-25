/**
 * Round coordinate arrays in command inputs so nearby callers share a server
 * cache entry.
 *
 * `BiasPosition` is a hint about where to look, so collapsing it onto a grid
 * lets two users in the same area reuse one upstream answer. `QueryPosition`
 * is not a hint — reverse-geocode resolves an exact point a user clicked or a
 * device reported, and rounding it returns a neighbour's address. It is left
 * alone (RFC-0001 §2).
 *
 * WHY THE DEFAULT MOVED FROM 2 dp TO 3 dp
 *
 * 2 dp is a ~1.1 km grid, and that is not a coarser answer — it is a wrong
 * one. Measured against Amazon Location directly, `QueryText: "cafe"` from
 * Sydney CBD returns a completely different set of places when the bias moves
 * 111 m:
 *
 *   base      -> Crepe de Paris | Deli Ziosa | CBD Patisserie
 *   +111 m    -> Cafe Chocolat  | Paradiso Cafe | Incanto Coffee
 *
 * So two users a kilometre apart both received whichever places were nearest
 * the FIRST of them, with nothing in the response saying so. The server moved
 * to 3 dp in api#21 — but this library rounds BEFORE sending, on both the
 * browser and server paths, so the precision was already gone by the time the
 * request arrived and that fix never reached anyone using the SDK. This is
 * what makes it reach them.
 *
 * The cost is hit rate: cells shrink 100x in area. RFC-0001 §5 expected only
 * "single-digit to low-double-digit percent" in mixed traffic, so there was
 * little to protect, and a miss costs one upstream call while a wrong answer
 * costs trust.
 */

/** The server's floor (api#65). A request for less is clamped up to it. */
export const DEFAULT_BIAS_DECIMALS = 3

/**
 * The band the server enforces (api#65). Mirrored here so the value this
 * library rounds to is the value the server will actually key its cache by —
 * rounding to something outside the band just means being wrong about what
 * was sent.
 *
 * The floor is correctness: below 3 dp the nearest places are not the ones
 * returned. The ceiling is cost: cells shrink 100x in area per decimal, so
 * finer precision collapses the cache hit rate and every miss is a billable
 * upstream call.
 */
export const MIN_BIAS_DECIMALS = 3
export const MAX_BIAS_DECIMALS = 5

/**
 * Clamp a requested precision into the allowed band.
 *
 * Anything absent or malformed becomes the default rather than throwing: this
 * runs on every request, and a surprising token claim must not break geocoding
 * for an application that is otherwise working.
 */
export function clampBiasDecimals(requested?: unknown): number {
  const n = Number(requested)
  if (
    (typeof requested !== 'number' &&
      !(typeof requested === 'string' && requested.trim() !== '')) ||
    !Number.isFinite(n)
  ) {
    return DEFAULT_BIAS_DECIMALS
  }
  const floored = Math.floor(n)
  if (floored < MIN_BIAS_DECIMALS) return MIN_BIAS_DECIMALS
  if (floored > MAX_BIAS_DECIMALS) return MAX_BIAS_DECIMALS
  return floored
}

/** Known position field names and whether they should be rounded */
const POSITION_FIELDS: Record<string, boolean> = {
  BiasPosition: true, // geocode, autocomplete, search — round for cache
  QueryPosition: false, // reverse geocode — keep full precision
}

function roundCoord(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Shallow-clone the input and round position arrays that benefit from caching.
 * Returns the original object if no position fields are present.
 *
 * @param input      the command input
 * @param decimals   precision for this application; defaults to the floor.
 *                   Comes from the `biasDecimals` JWT claim where the token
 *                   carries one (api#65) — an application entitled to finer
 *                   bias gets it without the caller configuring anything.
 */
export function roundPositionFields<T extends object>(
  input: T,
  decimals: number = DEFAULT_BIAS_DECIMALS,
): T {
  if (!input || typeof input !== 'object') return input

  const dp = clampBiasDecimals(decimals)
  let cloned: Record<string, unknown> | null = null

  for (const [field, shouldRound] of Object.entries(POSITION_FIELDS)) {
    if (!shouldRound) continue
    const value = (input as Record<string, unknown>)[field]
    if (!Array.isArray(value)) continue
    if (!cloned) cloned = { ...(input as Record<string, unknown>) }
    cloned[field] = value.map((v) =>
      typeof v === 'number' && Number.isFinite(v) ? roundCoord(v, dp) : v,
    )
  }

  return (cloned as T) ?? input
}
