import type { RequestTransformFunction } from 'maplibre-gl'

/**
 * Does this URL belong to our API?
 *
 * This decides who receives the customer's bearer token, and it used to be
 * `url.startsWith(apiUrl)` — a string test standing in for a URL test. For
 * `apiUrl = "https://api.example.com"`, the host `api.example.com.evil.test`
 * is a prefix match, so a style referencing
 * `https://api.example.com.evil.test/tiles/1/2/3` was handed
 * `Authorization: Bearer <token>` and the token left the building (#34).
 *
 * That is reachable because a style descriptor is DATA: its `sprite`, `glyphs`
 * and `sources` entries are URLs the style author chose, and MapLibre asks
 * transformRequest about every one of them. Any style not wholly ours — a
 * customer's own, or one edited through a tool — can name a host it likes.
 *
 * Compared as URLs instead, which also gets host case-folding, default ports
 * (`https://api.test:443` === `https://api.test`) and userinfo right for free,
 * and adds a path check so a shared host serving another tenant under a
 * different base path is not "ours" either.
 *
 * Fails CLOSED: anything that will not parse gets no token. The only way to
 * reach that is a relative `apiUrl` in a runtime with no `location` to resolve
 * it against — i.e. not a browser, which is the only place MapLibre runs.
 */
function isOurApi(url: string, apiUrl: string): boolean {
  const base = typeof location === 'undefined' ? undefined : location.href

  let ours: URL
  let theirs: URL
  try {
    ours = new URL(apiUrl, base)
    theirs = new URL(url, base)
  } catch {
    return false
  }

  if (theirs.origin !== ours.origin) return false

  // Trailing slashes normalised so `/v1` and `/v1/` behave the same; the `/`
  // boundary is what stops `/v1` from matching `/v1-internal`.
  const basePath = ours.pathname.replace(/\/+$/, '')
  return (
    theirs.pathname === basePath || theirs.pathname.startsWith(`${basePath}/`)
  )
}

/**
 * Creates a transformRequest function for MapLibre that adds authentication
 * and proper Accept headers for AWS Location Service API requests.
 *
 * The token is attached to our own API and nowhere else — see isOurApi.
 *
 * @param apiUrl - Base URL of the Location Service API
 * @param getToken - Callback function that returns the current auth token
 * @returns MapLibre transformRequest function
 */
export function createTransformRequest(
  apiUrl: string,
  getToken: () => string | undefined,
): RequestTransformFunction {
  return (url: string, _resourceType?: string) => {
    if (isOurApi(url, apiUrl)) {
      const token = getToken()
      if (!token) {
        console.warn('[createTransformRequest] No token available')
        return { url }
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      }

      // Set appropriate Accept headers based on resource type
      if (url.includes('/tiles/')) {
        headers['Accept'] = 'application/x-protobuf'
      } else if (url.includes('/glyphs/')) {
        headers['Accept'] = 'application/x-protobuf'
      } else if (url.includes('/sprites/') && url.endsWith('.png')) {
        headers['Accept'] = 'image/png'
      } else if (url.includes('/sprites/') && url.endsWith('.json')) {
        headers['Accept'] = 'application/json'
      } else if (url.includes('/descriptor')) {
        headers['Accept'] = 'application/json'
      }

      return { url, headers }
    }
    return { url }
  }
}
