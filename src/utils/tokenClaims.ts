/**
 * Read advisory application config out of the access token (api#65).
 *
 * The API puts an application's own settings into the JWT — `countries`,
 * `allowedResources` and `allowedDomain` — so this library can stop
 * hard-coding values it has no other way of knowing. The last two were in the
 * token all along and were not surfaced until #40, so an application could
 * only learn it lacked a route from the 403.
 *
 * `biasDecimals` used to be here too. It sized the grid this library rounded
 * `BiasPosition` onto, so that nearby callers shared a server cache entry; the
 * cache is gone, the API issues no such claim, and rounding a coordinate with
 * nothing to share it with only lowered the precision the upstream geocoder
 * received (#51).
 *
 * DELIBERATELY UNVERIFIED, and that is safe. This library has no signing key
 * and does not need one: every claim here is re-read from the application row
 * by the API on each request, and the API's answer is the one that counts. A
 * forged token would fail at the authorizer long before any of this mattered.
 * Nothing read here reaches a request at all now — it is displayed, never
 * acted on, so a forged value misinforms only the caller who forged it.
 *
 * A JWT is signed, not encrypted, so the payload is plain base64url. Nothing
 * secret is in it; these are the caller's own settings.
 */

export interface AppConfigClaims {
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

  /**
   * The routes this application may call, as the API names them — method and
   * route template, such as `POST /address/autocomplete` or
   * `GET /maps/static/{fileName}` (#40).
   *
   * So an application can ask "may I show a static map?" before it offers
   * one, rather than only learning from the 403. The same rule as `countries`
   * applies, for the same reason: show it, never refuse with it. A route
   * granted since the token was minted is answered by the API, which reads the
   * entitlement fresh on every request.
   *
   * The API issues this claim JSON-encoded — a string holding the list —
   * because it copies the application's stored setting. Both forms are read.
   */
  allowedResources?: string[]

  /**
   * The domain this application's requests must come from (#40). A request
   * whose `Origin` is neither this host nor one of its subdomains is refused
   * 403, so this is what to show next to "Origin not allowed".
   */
  allowedDomain?: string
}

/** A list of strings, whether the claim carries it as a list or JSON-encoded. */
function readStringList(value: unknown): string[] | undefined {
  let list = value
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(list)) return undefined
  return list.filter((v): v is string => typeof v === 'string')
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
    if (Array.isArray(payload.countries)) {
      const list = payload.countries.filter(
        (c): c is string => typeof c === 'string',
      )
      if (list.length) claims.countries = list
    }
    // Kept when empty, unlike countries: no countries means "search the
    // world", but no resources means an application entitled to nothing.
    const resources = readStringList(payload.allowedResources)
    if (resources) claims.allowedResources = resources
    if (typeof payload.allowedDomain === 'string' && payload.allowedDomain) {
      claims.allowedDomain = payload.allowedDomain
    }
    return claims
  } catch {
    return {}
  }
}
