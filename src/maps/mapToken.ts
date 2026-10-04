import { TokenHold, holdFor, sendRetryingOnce } from '../auth/tokenHold.js'
import { LocationServiceException } from '../errors/LocationServiceException.js'
import { noTokenAvailable } from '../transport/errors.js'
import type { CallOptions } from '../transport/http.js'
import { withinCall } from '../transport/http.js'
import { isOurApi } from './createTransformRequest.js'

/**
 * Where a map helper gets its token, and how it gets a new one (#72).
 *
 * `getToken` is synchronous by contract: MapLibre's `transformRequest` calls
 * it for every tile and cannot wait. `refreshToken` is how a map recovers when
 * the API refuses the token in hand before its `exp` — a rotated secret, for
 * one — which nothing else in the map path can do. It is the escape hatch
 * `GeoPlacesClient` takes, under the same name.
 */
export interface MapTokens {
  /** The token in hand, now. */
  getToken: () => string | undefined
  /** Obtain a new token after the API refused the one in hand. */
  refreshToken?: () => Promise<string | undefined>
}

/** A bare `getToken`, which behaves as it always has, or `MapTokens`. */
export type MapTokenSource = (() => string | undefined) | MapTokens

/**
 * One hold per `MapTokens` object, so the helpers handed the same one share
 * what the API and `refreshToken` said (#38): a refusal one of them met is not
 * asked again by the next. A bare `getToken` never asks again, and needs none.
 */
const holds = new WeakMap<MapTokens, TokenHold>()

function holdOf(tokens: MapTokens): TokenHold {
  let hold = holds.get(tokens)
  if (!hold) holds.set(tokens, (hold = new TokenHold()))
  return hold
}

/**
 * Send with the token in hand, and after a 401 once more with a different one
 * from `refreshToken`, all within the call's signal and deadline (#62). A 403
 * is never retried, and neither is the token the API refused.
 */
export async function sendWithTokenRefresh<T>(
  source: MapTokenSource,
  noTokenAdvice: string,
  call: CallOptions,
  send: (token: string) => Promise<T>,
): Promise<T> {
  const tokens: MapTokens =
    typeof source === 'function' ? { getToken: source } : source
  const token = tokens.getToken()
  if (!token) throw noTokenAvailable(noTokenAdvice)

  const { refreshToken } = tokens
  if (!refreshToken) return send(token)
  return sendRetryingOnce(
    holdOf(tokens),
    token,
    send,
    async () => (await withinCall(refreshToken(), call)) ?? tokens.getToken(),
  )
}

/** A tile's coordinates, as `map.refreshTiles` takes them. */
interface TileCoordinates {
  x: number
  y: number
  z: number
}

/** What MapLibre's `error` event carries for a refused request. */
interface MapErrorEvent {
  error?: { status?: number; url?: string }
  sourceId?: string
  tile?: { tileID: { canonical: TileCoordinates } }
}

/** The part of a MapLibre `Map` that `refreshTokenOnUnauthorized` uses. */
export interface TokenRefreshMap {
  on(type: 'error', listener: (event: MapErrorEvent) => void): unknown
  off(type: 'error', listener: (event: MapErrorEvent) => void): unknown
  refreshTiles(sourceId: string, tileIds?: TileCoordinates[]): void
}

/**
 * Recover the tiles MapLibre fetches itself when the API refuses the token
 * (#72).
 *
 * `createTransformRequest` builds each request synchronously and never sees
 * the answer, so a refused tile used to leave a hole until the page reloaded.
 * This listens for MapLibre's `error` events. On a 401 from a URL of our API it
 * asks `refreshToken` once for the whole burst. When `getToken` then returns a
 * different token, it reloads each refused tile with `map.refreshTiles`, whose
 * requests carry that token. So `refreshToken` must make `getToken` return
 * what it obtained: the tiles have no other way to receive it. A refused
 * request that is not a tile (a glyph, a sprite) has the token replaced for
 * the next one, and nothing reloaded.
 *
 * Tiles are reloaded by id, never a whole source: MapLibre 6 reloads a source's
 * errored tiles as still loading, and they wait for a load that never comes.
 *
 * What it learns is held as the fetch helpers hold it, and shared with them
 * when they are handed the same `tokens` object (#38): a token `refreshToken`
 * could not replace, and a failure that says when to ask again, are not asked
 * about again until they lapse or the token in hand changes.
 *
 * Returns a function that stops listening.
 *
 * @example
 * const tokens = { getToken, refreshToken }
 * const map = new Map({
 *   container: 'map',
 *   style: await fetchMapStyle(API_URL, 'Standard', tokens),
 *   transformRequest: createTransformRequest(API_URL, getToken),
 * })
 * refreshTokenOnUnauthorized(map, API_URL, tokens)
 */
export function refreshTokenOnUnauthorized(
  map: TokenRefreshMap,
  apiUrl: string,
  tokens: Required<MapTokens>,
): () => void {
  const hold = holdOf(tokens)
  // Each source's refused tiles, keyed `z/x/y` so a tile refused twice is
  // reloaded once.
  const refused = new Map<string, Map<string, TileCoordinates>>()
  let asking = false

  const onError = ({ error, sourceId, tile }: MapErrorEvent) => {
    if (error?.status !== 401 || !error.url || !isOurApi(error.url, apiUrl))
      return
    if (sourceId && tile) {
      const { x, y, z } = tile.tileID.canonical
      const tiles = refused.get(sourceId) ?? new Map()
      refused.set(sourceId, tiles.set(`${z}/${x}/${y}`, { x, y, z }))
    }
    if (asking) return

    const inHand = tokens.getToken()
    const held = hold.check(inHand)
    if (held && !held.askAgain) return

    asking = true
    // Asked inside an executor, so a `refreshToken` that throws instead of
    // rejecting lands in the catch below rather than in MapLibre's emitter.
    new Promise<string | undefined>((resolve) => resolve(tokens.refreshToken()))
      .then(() => {
        // A reloaded tile takes its token from `getToken`, as every tile does,
        // so that is the token that must have changed. Reloading on what
        // `refreshToken` returned alone would send the refused one again, and
        // its 401 would ask again: a loop of refreshes and reloads.
        const now = tokens.getToken()
        if (!now || now === inHand) {
          // MapLibre's error carries none of the API's fields, so the refusal
          // is remembered as the 401 it was.
          hold.remember(
            new LocationServiceException({
              code: 'UnauthorizedException',
              message:
                'The API refused the token, and getToken has no other since refreshToken settled.',
              statusCode: 401,
            }),
            inHand,
          )
          return
        }
        for (const [id, tiles] of refused)
          map.refreshTiles(id, [...tiles.values()])
      })
      .catch((refusal: unknown) => {
        // Only a failure that says when to ask again is remembered; any other
        // leaves the next refused tile to ask, as the send paths do.
        if (holdFor(refusal) > 0) hold.remember(refusal, inHand)
      })
      .finally(() => {
        refused.clear()
        asking = false
      })
  }

  map.on('error', onError)
  return () => map.off('error', onError)
}
