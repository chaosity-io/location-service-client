/**
 * Round coordinate arrays in command inputs for better API cache hits.
 *
 * BiasPosition is rounded to 2 decimal places (~1.1 km precision) —
 * sufficient for spatial biasing while maximizing cache reuse across
 * nearby users.
 *
 * QueryPosition (reverse geocode) keeps full precision since it
 * represents an exact point the user clicked or their device reported.
 */

const BIAS_DECIMALS = 2 // ~1.1 km grid
const BIAS_FACTOR = 10 ** BIAS_DECIMALS

/** Known position field names and whether they should be rounded */
const POSITION_FIELDS: Record<string, boolean> = {
  BiasPosition: true, // geocode, autocomplete, search — round for cache
  QueryPosition: false, // reverse geocode — keep full precision
}

function roundCoord(value: number): number {
  return Math.round(value * BIAS_FACTOR) / BIAS_FACTOR
}

/**
 * Shallow-clone the input and round position arrays that benefit from caching.
 * Returns the original object if no position fields are present.
 */
export function roundPositionFields<T extends object>(input: T): T {
  if (!input || typeof input !== 'object') return input

  let modified = false
  const result = { ...input } as Record<string, unknown>

  for (const [field, shouldRound] of Object.entries(POSITION_FIELDS)) {
    const value = result[field]
    if (!shouldRound || !Array.isArray(value) || value.length < 2) continue

    result[field] = value.map(roundCoord)
    modified = true
  }

  return modified ? (result as T) : input
}
