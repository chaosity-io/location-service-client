/**
 * Read advisory application config out of the access token (api#65).
 *
 * The API puts an application's own settings — `biasDecimals`, `countries` —
 * into the JWT alongside `allowedDomain` and `allowedResources`, so this
 * library can stop hard-coding values it has no other way of knowing.
 *
 * DELIBERATELY UNVERIFIED, and that is safe. This library has no signing key
 * and does not need one: every claim here is re-read from the application row
 * by the API on each request, and the API's answer is the one that counts. A
 * forged token would fail at the authorizer long before any of this mattered.
 * What is read here only decides how the request is SHAPED — a hint, never a
 * permission.
 *
 * A JWT is signed, not encrypted, so the payload is plain base64url. Nothing
 * secret is in it; these are the caller's own settings.
 */

export interface AppConfigClaims {
  /**
   * Bias precision this application is entitled to.
   *
   * Safe to act on: it only changes how a coordinate is rounded before
   * sending, and the server re-rounds to its own configured value anyway. A
   * stale value here costs precision, never correctness.
   */
  biasDecimals?: number
  /**
   * Countries this application may search, ISO 3166-1 alpha-2.
   *
   * READ THIS, DO NOT ACT ON IT. It is here to be displayed — a country
   * selector, a settings screen, a "this application serves AU and NZ" label.
   *
   * Do not inject it into requests and do not reject requests with it. The
   * token is a snapshot up to fifteen minutes old; the API reads the scope
   * fresh from the application row on every request. Acting on a stale value
   * makes things WORSE, in both directions:
   *
   *   app is now scoped to NZ, token still says AU
   *     send nothing         -> API injects [NZ]  -> 200
   *     inject stale [AU]    -> outside scope     -> 400
   *
   * So a request that would have succeeded fails instead. Rejecting locally
   * has the mirror-image bug: refusing something the API would now allow.
   * Sending nothing and letting the API scope the request is always correct.
   */
  countries?: string[]
}

/**
 * Decode a JWT payload without verifying it.
 *
 * Returns `{}` for anything unparseable. This runs on every request, so a
 * surprising token must degrade to "no claims" rather than break geocoding
 * for an application that is otherwise working.
 */
export function readAppConfigClaims(token?: string | null): AppConfigClaims {
  if (typeof token !== 'string') return {}

  const parts = token.split('.')
  if (parts.length !== 3) return {}

  try {
    // base64url -> base64: JWT omits padding and swaps two characters.
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
    // `atob` exists in browsers and in Node 16+, so one path serves both.
    const json = decodeURIComponent(
      Array.from(
        atob(padded),
        (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
      ).join(''),
    )
    const payload = JSON.parse(json) as Record<string, unknown>

    const claims: AppConfigClaims = {}
    if (typeof payload.biasDecimals === 'number') {
      claims.biasDecimals = payload.biasDecimals
    } else if (
      typeof payload.biasDecimals === 'string' &&
      payload.biasDecimals.trim() !== ''
    ) {
      const n = Number(payload.biasDecimals)
      if (Number.isFinite(n)) claims.biasDecimals = n
    }
    if (Array.isArray(payload.countries)) {
      const list = payload.countries.filter(
        (c): c is string => typeof c === 'string',
      )
      if (list.length) claims.countries = list
    }
    return claims
  } catch {
    return {}
  }
}
