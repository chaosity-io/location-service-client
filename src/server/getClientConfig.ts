import debug from 'debug'
import { createHash } from 'node:crypto'
import type { TokenResponse } from '../auth/TokenProvider.js'
import { TokenProvider } from '../auth/TokenProvider.js'
import { LocationServiceException } from '../errors/LocationServiceException.js'
import type { ClientConfig } from '../types/index.js'
export interface ServerAuthConfig {
  apiUrl?: string
  clientId?: string
  clientSecret?: string
  /**
   * Mint a new token instead of returning the cached one.
   *
   * For the case the cache cannot see: a token the API has stopped accepting
   * before its `exp` — revoked in the portal, or issued against a secret that
   * has since been rotated. `TokenProvider` judges freshness from `exp` alone,
   * so without this a caller holding a dead token waits out its whole lifetime.
   */
  forceRefresh?: boolean
}

const log = debug('location-client:clientConfig')

/**
 * How many applications one process keeps token providers for.
 *
 * A provider holds a URL, a client id, a secret and one cached JWT, so the
 * ceiling is about memory containment rather than a tuned working set — 64 is
 * far above what a single-tenant service needs and far below anything worth
 * worrying about. An agency past it pays a re-mint for the least recently used
 * application, which is exactly the behaviour this replaced, but only for the
 * coldest one instead of for every alternation.
 */
export const MAX_CACHED_PROVIDERS = 64

/**
 * One provider per configuration, most-recently-used last.
 *
 * This used to be TWO module-level variables holding a single provider, and a
 * process serving more than one application therefore evicted the cache on
 * every alternation: A→B→A→B took a full `/auth/token` round trip per call,
 * each writing a jti row, all against the one shared token-endpoint throttle.
 * The hit rate under alternating load was 0% (#39). Nothing leaked between
 * tenants — each caller closes over the provider it asked for — so what this
 * fixes is availability and cost, not confidentiality.
 *
 * A `Map` iterates in insertion order, so re-inserting on a hit makes the first
 * key the least recently used, and an LRU needs no other bookkeeping.
 */
const tokenProviders = new Map<string, TokenProvider>()

function getTokenProvider(
  apiUrl: string,
  clientId: string,
  clientSecret: string,
): TokenProvider {
  // The SECRET is part of the key. Without it, rotating a client secret while
  // keeping the same clientId left this process reusing a provider built on the
  // old secret — so the rotation appeared to do nothing until a restart. Hashed
  // rather than concatenated so the key is never a secret in its own right, and
  // never ends up in a log line (#5).
  const configKey = `${apiUrl}:${clientId}:${createHash('sha256').update(clientSecret).digest('hex').slice(0, 16)}`

  const cached = tokenProviders.get(configKey)
  if (cached) {
    log('[getTokenProvider] Reusing existing TokenProvider instance')
    // Re-insert to mark it most recently used.
    tokenProviders.delete(configKey)
    tokenProviders.set(configKey, cached)
    return cached
  }

  log('[getTokenProvider] Creating new TokenProvider instance')
  const provider = new TokenProvider({ apiUrl, clientId, clientSecret })
  tokenProviders.set(configKey, provider)

  if (tokenProviders.size > MAX_CACHED_PROVIDERS) {
    const leastRecentlyUsed = tokenProviders.keys().next().value
    /* c8 ignore next — size > 0 here, so the iterator always yields */
    if (leastRecentlyUsed !== undefined) {
      log('[getTokenProvider] Evicting the least recently used TokenProvider')
      tokenProviders.delete(leastRecentlyUsed)
    }
  }

  return provider
}

export interface ServerClientConfig extends ClientConfig {
  /**
   * Narrowed back to required. `ClientConfig.token` is optional because a
   * client can be driven by `getToken`/`refreshToken` alone, but this type is
   * what `getClientConfig` RESOLVES — it either has a token or it threw — and
   * widening it would push a needless `string | undefined` onto every consumer
   * that reads `config.token`.
   */
  token: string
  expiresAt?: number
}

/**
 * Where the API lives, from the argument or the environment.
 *
 * Separate from the credentials because the two are independently overridable:
 * a caller can hand `LocationServiceConnector` its own `token` and still expect
 * `LOCATION_API_URL` to say where to send it.
 */
export function resolveApiUrl(explicit?: string): string | undefined {
  return (
    explicit ||
    process.env.LOCATION_API_URL ||
    process.env.LOCATION_SERVICE_API_URL
  )
}

/**
 * A LIVE token source: resolved credentials plus a `getToken` that re-mints
 * when the cached token is spent.
 *
 * This is the seam `getClientConfig` and `LocationServiceConnector` share, and
 * it exists because the two need different SHAPES of the same thing.
 * `getClientConfig` has to return plain data — see the warning on its return
 * value — so it can only ever hand back a snapshot. The connector is long-lived
 * and needs the source itself, or it dies at the first `exp` (#36).
 *
 * Deliberately not exported from `./server`: it hands out a callable bound to
 * the process-wide provider, and the public surface stays the two functions
 * that were already there.
 */
export interface ServerTokenSource {
  apiUrl: string
  /** Resolves with a token or rejects; it never resolves tokenless. */
  getToken(forceRefresh?: boolean): Promise<TokenResponse & { token: string }>
}

export function serverTokenSource(
  config: ServerAuthConfig = {},
): ServerTokenSource {
  log('[serverTokenSource] Starting with config:', {
    hasApiUrl: !!config.apiUrl,
    hasClientId: !!config.clientId,
  })

  // Auto-detect from environment with fallbacks
  const apiUrl = resolveApiUrl(config.apiUrl)

  const clientId =
    config.clientId ||
    process.env.LOCATION_CLIENT_ID ||
    process.env.LOCATION_SERVICE_CLIENT_ID

  const clientSecret =
    config.clientSecret ||
    process.env.LOCATION_CLIENT_SECRET ||
    process.env.LOCATION_SERVICE_CLIENT_SECRET

  log('[serverTokenSource] Resolved config:', {
    apiUrl,
    clientId: clientId?.substring(0, 10) + '...',
  })

  // Validate required values. A LocationServiceException like everything else
  // this package throws — it used to be a bare `Error`, which was survivable
  // while only `getClientConfig` could raise it and is not now that the
  // connector reaches this path too.
  if (!apiUrl || !clientId || !clientSecret) {
    console.error('[location-client] Missing required configuration')
    throw new LocationServiceException({
      code: 'ValidationException',
      message:
        'Missing required configuration. Set environment variables: ' +
        'LOCATION_API_URL, LOCATION_CLIENT_ID, LOCATION_CLIENT_SECRET',
      details: { source: 'client' },
    })
  }

  log('[serverTokenSource] Getting TokenProvider instance')
  const provider = getTokenProvider(apiUrl, clientId, clientSecret)

  return {
    apiUrl,
    async getToken(
      forceRefresh = false,
    ): Promise<TokenResponse & { token: string }> {
      log('[serverTokenSource] Fetching token (forceRefresh=%s)', forceRefresh)
      let result
      try {
        result = await provider.getToken(forceRefresh)
      } catch (error) {
        // The provider now rejects rather than resolving with success:false, and
        // the rejection is typed — so a store outage (503) can be reported as a
        // store outage instead of as bad credentials.
        if (error instanceof LocationServiceException) {
          if (error.isAuth) {
            throw new LocationServiceException({
              code: 'InvalidCredentialsException',
              message:
                `Authentication failed for client ID "${clientId}". ` +
                `Verify LOCATION_CLIENT_ID and LOCATION_CLIENT_SECRET match your application in the developer portal.`,
              statusCode: error.statusCode,
              requestId: error.requestId,
              cause: error,
            })
          }
          throw error
        }
        throw error
      }

      // TokenProvider rejects rather than returning a tokenless success, so this
      // is unreachable in practice — it is here to keep the contract explicit at
      // the type level rather than asserting non-null.
      const token = result.token
      if (!token) {
        throw new LocationServiceException({
          code: 'InvalidCredentialsException',
          message: 'Token provider returned no token',
          details: { source: 'client' },
        })
      }

      return { ...result, token }
    },
  }
}

/**
 * Get client configuration with OAuth2 authentication.
 *
 * Automatically reads from environment variables:
 * - LOCATION_API_URL or LOCATION_SERVICE_API_URL
 * - LOCATION_CLIENT_ID or LOCATION_SERVICE_CLIENT_ID
 * - LOCATION_CLIENT_SECRET or LOCATION_SERVICE_CLIENT_SECRET
 *
 * You can override any value by passing it explicitly.
 *
 * WARNING: This function uses client credentials (clientId/clientSecret).
 * Only call this from:
 * - Next.js Server Components/Actions
 * - Node.js backend servers
 * - API routes
 *
 * NEVER call from browser/client code as it exposes credentials.
 * For SPA projects, create your own backend endpoint that calls this.
 *
 * ## The return value is PLAIN DATA, and has to stay that way
 *
 * `{ apiUrl, token, expiresAt }` — no methods, no closures. The reason is not
 * style: the shape every sample uses is a Next.js Server Action that returns
 * this straight to a Client Component (every `src/lib/actions/location.ts`
 * under `location-service-samples/web`), and the RSC boundary
 * serialises it. A function on this object is not serialisable and throws at
 * the boundary, so "make getClientConfig return getToken" — which #36 proposed
 * and this JSDoc used to promise two lines below — would break every Next.js
 * consumer of the library.
 *
 * A caller that needs a token which REFRESHES wants one of:
 * - `LocationServiceConnector`, which holds a live source internally (#36), or
 * - `TokenProvider` directly, if it is managing its own lifecycle.
 *
 * @example
 * // Auto-detect from environment
 * const config = await getClientConfig()
 *
 * // Or override specific values
 * const config = await getClientConfig({ apiUrl: 'https://custom.api.com' })
 *
 * // The API rejected the token before its exp — revoked, or secret rotated
 * const fresh = await getClientConfig({ forceRefresh: true })
 */
export async function getClientConfig(
  config: ServerAuthConfig = {},
): Promise<ServerClientConfig> {
  const source = serverTokenSource(config)
  const result = await source.getToken(config.forceRefresh)

  log(
    '[getClientConfig] Token fetched successfully, length:',
    result.token.length,
  )
  return {
    apiUrl: source.apiUrl,
    token: result.token,
    expiresAt: result.expiresAt,
  }
}
