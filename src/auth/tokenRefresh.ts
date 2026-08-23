/**
 * How long before expiry a token is treated as needing replacement.
 *
 * ONE number, used by both sides: the server-side `TokenProvider` deciding
 * whether its cached token is still good, and the React provider deciding
 * whether to ask for a new one. Both apply it to the same `exp` claim, so they
 * cannot reach different answers about the same token.
 *
 * It used to be two separate `60`s — a private literal in `isExpired()` and a
 * public `refreshBuffer` prop default — with nothing tying them together. On
 * 2026-08-23 a consumer passed `refreshBuffer={800}` against a 900 s token: the
 * client judged it stale after 100 s, the server still considered it fresh for
 * another 840 s and returned the same one, and the client asked again
 * immediately — roughly 110 requests per second from an idle page.
 *
 * Not configurable per consumer, deliberately. A settable client-side buffer is
 * precisely what allowed that disagreement, and no amount of capping or backing
 * off fixes it as cleanly as the two sides simply sharing the number.
 */
export const TOKEN_REFRESH_BUFFER_SECONDS = 60

/**
 * Read the `exp` claim out of a JWT, in milliseconds.
 *
 * The expiry is IN THE TOKEN, so neither side needs to be told it. Both used to
 * take it on trust from elsewhere — the server from the response body's
 * `expires_at`, the React provider from whatever `getConfig` returned, falling
 * back to inventing `Date.now() + 900_000` when that was absent. An invented
 * expiry is how the two ended up disagreeing about the same token.
 *
 * Deliberately NOT verified. This is only used to decide *when to refresh*;
 * nothing is authorised on the strength of it, and the API verifies the
 * signature on every request regardless. Trusting `exp` for scheduling is safe
 * in a way that trusting it for access would not be.
 *
 * Returns undefined for anything unparseable, so callers keep their fallback.
 */
export function readTokenExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json =
      typeof atob === 'function'
        ? atob(base64)
        : Buffer.from(base64, 'base64').toString('utf8')
    const exp = JSON.parse(json)?.exp
    return typeof exp === 'number' ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}
