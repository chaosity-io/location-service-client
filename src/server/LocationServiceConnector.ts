import debug from 'debug'
import { LocationServiceException } from '../errors/LocationServiceException.js'
import { resolveEndpoint } from '../transport/endpoints.js'
import { isTokenRejected } from '../transport/errors.js'
import type { RequestOptions } from '../transport/http.js'
import { requestJson } from '../transport/http.js'
import type { GeoPlacesCommand } from '../types/index.js'
import { roundPositionFields } from '../utils/roundPosition.js'
import type { AppConfigClaims } from '../utils/tokenClaims.js'
import { readAppConfigClaims } from '../utils/tokenClaims.js'
import { resolveApiUrl, serverTokenSource } from './getClientConfig.js'

const log = debug('location-client:connector')

export interface ConnectorConfig {
  /** Falls back to `LOCATION_API_URL` / `LOCATION_SERVICE_API_URL`. */
  apiUrl?: string
  /**
   * A fixed token. Nothing can refresh it, so it dies at its own `exp` — pass
   * `getToken` instead, or nothing at all, for a connector that keeps working.
   */
  token?: string
  /**
   * Where a token comes from. Called for every request, so this is what makes
   * a long-lived connector survive expiry.
   *
   * `forceRefresh` is passed as `true` when the API has just rejected the token
   * this returned — the signature is `TokenProvider.getToken`'s exactly, so
   * `getToken: (f) => provider.getToken(f)` is a complete implementation.
   */
  getToken?: (
    forceRefresh?: boolean,
  ) => Promise<string | { token?: string } | undefined>
  /** Falls back to `LOCATION_CLIENT_ID` / `LOCATION_SERVICE_CLIENT_ID`. */
  clientId?: string
  /** Falls back to `LOCATION_CLIENT_SECRET` / `LOCATION_SERVICE_CLIENT_SECRET`. */
  clientSecret?: string
  /**
   * Sent as the `Origin` header on every request. The API requires an Origin it
   * recognises on every data request and answers 403 without one, so every
   * caller was setting it by hand on each `send`; this does it once.
   *
   * Falls back to `LOCATION_ORIGIN` / `LOCATION_SERVICE_ORIGIN`, so the
   * zero-argument connector can be made to work from the environment alone.
   */
  origin?: string
}

export interface SendOptions extends RequestOptions {
  headers?: Record<string, string>
}

/** Where this connector's tokens come from, whichever way it was configured. */
interface TokenSource {
  /**
   * Resolved when a request is about to be sent, NOT when the source is built —
   * `getAppConfig` reads claims off the token and needs no URL at all, and used
   * to fail on a connector configured with a bare `token` because this was
   * demanded up front.
   */
  apiUrl(): string
  /**
   * `forceRefresh` asks for a replacement rather than the cached token. A
   * source with nothing to refresh answers with the same one, which is exactly
   * what the retry guard in `dispatchWithRetry` reads.
   */
  get(forceRefresh?: boolean): Promise<string | undefined>
}

/** Header lookup that does not care how the caller capitalised the name. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

/**
 * The headers `dispatch` sets itself, and which a caller therefore cannot
 * supply. Lower-case, because that is how they are compared.
 *
 * Kept beside `withoutHeaders` so the list and the record in `dispatch` cannot
 * drift apart: a header added there must be added here too, or the caller's own
 * spelling of it survives the merge.
 */
const SYSTEM_HEADERS = ['origin', 'content-type', 'authorization']

/** The caller's headers minus `names`, however they capitalised them. */
function withoutHeaders(
  headers: Record<string, string> | undefined,
  names: string[],
): Record<string, string> {
  if (!headers) return {}
  const wanted = new Set(names)
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !wanted.has(key.toLowerCase())),
  )
}

/**
 * Say why the 403 happened, when we know.
 *
 * `Origin not allowed` with no Origin sent is not an ambiguous failure — it is
 * the documented backend path missing one piece of configuration (#45), and the
 * API's own message cannot say so because from its side the header is simply
 * absent. A new integrator following the README hit a bare "Origin not allowed"
 * that named neither the cause nor the fix.
 */
function explainMissingOrigin(
  err: unknown,
  sentOrigin: string | undefined,
): unknown {
  if (sentOrigin) return err
  if (!(err instanceof LocationServiceException)) return err
  if (err.code !== 'OriginNotAllowedException') return err

  return new LocationServiceException({
    code: err.code,
    message:
      `${err.message} — this request carried no Origin header, and the API requires ` +
      `one it recognises on every data request. Set \`origin\` on the ` +
      `LocationServiceConnector, set LOCATION_ORIGIN, or pass an Origin in the ` +
      `per-call headers; if the application has no allowed domain configured in ` +
      `the developer portal yet, set that first.`,
    statusCode: err.statusCode,
    requestId: err.requestId,
    details: err.details,
    cause: err,
  })
}

/**
 * LocationServiceConnector — server-side connector for the Location Service API.
 *
 * Backend-to-backend: automatic configuration from the environment, server-side
 * token management, and the same transport (timeout, cancellation, retry) as the
 * browser client.
 *
 * Configuration is COMPLETED from the environment rather than replaced by it.
 * The constructor used to be all-or-nothing — any argument at all took the
 * "caller supplies everything" branch — so `new LocationServiceConnector()` had
 * credentials but could never send an Origin (403 on every data request) and
 * `new LocationServiceConnector({ origin })` had an Origin but no credentials
 * (#45). Now an explicit `token`/`getToken` still wins outright, and anything
 * short of that is filled in from `LOCATION_API_URL` / `LOCATION_CLIENT_ID` /
 * `LOCATION_CLIENT_SECRET` / `LOCATION_ORIGIN`.
 *
 * @example
 * ```typescript
 * // Credentials and apiUrl from the environment, Origin supplied here
 * const connector = new LocationServiceConnector({ origin: 'https://app.example.com' })
 * const result = await connector.send(new SearchTextCommand({ QueryText: 'Space Needle' }))
 * ```
 */
export class LocationServiceConnector {
  private readonly config: ConnectorConfig
  private tokenSource?: TokenSource
  private readonly origin?: string
  public readonly serviceId: string = 'Geo Places'

  constructor(config: ConnectorConfig = {}) {
    this.config = config
    // `||`, not `??`, to match the other four env-completed fields: an empty
    // string is not a choice to send no Origin, it is a missing value, and the
    // asymmetry meant `origin: ''` suppressed the environment and then produced
    // an error telling the caller to set a variable they may already have set.
    this.origin =
      config.origin ||
      process.env.LOCATION_ORIGIN ||
      process.env.LOCATION_SERVICE_ORIGIN
  }

  /**
   * One place that knows how a token is obtained, so nothing can drift.
   *
   * Built on first use rather than in the constructor: resolving the
   * environment path used to start a `/auth/token` round trip from `new`, whose
   * rejection nothing was awaiting yet — an unhandled rejection for a
   * misconfigured process, before it had made a single request.
   */
  private source(): TokenSource {
    return (this.tokenSource ??= this.buildSource())
  }

  private buildSource(): TokenSource {
    const { apiUrl, token, getToken, clientId, clientSecret } = this.config

    // An explicit token source wins outright. A caller that supplied one is
    // managing credentials itself, and quietly reading the environment
    // underneath it could send another application's token.
    if (getToken) {
      return {
        apiUrl: () => requireApiUrl(apiUrl),
        get: async (forceRefresh) => {
          const result = await getToken(forceRefresh)
          if (!result) return undefined
          return typeof result === 'string' ? result : result.token
        },
      }
    }

    if (token) {
      return {
        apiUrl: () => requireApiUrl(apiUrl),
        // A fixed string. Asking again returns the same one, which is how the
        // retry guard knows there is nothing to retry with.
        get: async () => token,
      }
    }

    // Nothing but (at most) an apiUrl and an origin — complete it from the
    // environment. This is the branch every sample and doc actually takes.
    const env = serverTokenSource({ apiUrl, clientId, clientSecret })
    return {
      // Already validated by serverTokenSource, which cannot resolve
      // credentials without it.
      apiUrl: () => env.apiUrl,
      get: async (forceRefresh) => (await env.getToken(forceRefresh)).token,
    }
  }

  /**
   * This application's own configuration, as carried on the access token
   * (api#65) — bias precision, and the countries it is scoped to.
   *
   * Provided so an application can SHOW its own settings: populate a country
   * selector with the markets it actually serves, label a settings screen, and
   * so on. Being a few minutes stale is cosmetic for that.
   *
   * It is not an entitlement check. See AppConfigClaims for why acting on
   * `countries` client-side makes requests fail that would otherwise succeed.
   *
   * Returns `{}` when the token carries no application config, which is the
   * case until one is configured in the portal.
   */
  async getAppConfig(): Promise<AppConfigClaims> {
    return readAppConfigClaims(await this.source().get())
  }

  /**
   * The Origin this request will actually carry.
   *
   * ONE definition, for the two readers that must never disagree about it: the
   * header merge in `dispatch`, and the 403 explanation in `send`. A per-call
   * header beats the connector default, whatever the caller capitalised.
   */
  private effectiveOrigin(options?: SendOptions): string | undefined {
    // `||` for the same reason as the constructor: an empty per-call header is
    // a missing value, not a decision to send no Origin.
    return headerValue(options?.headers, 'origin') || this.origin
  }

  async send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput> {
    const source = this.source()
    const cmd = command as unknown as GeoPlacesCommand
    const url = `${source.apiUrl()}${resolveEndpoint(cmd)}`

    try {
      return await this.dispatchWithRetry<TOutput>(source, url, cmd, options)
    } catch (err) {
      throw explainMissingOrigin(err, this.effectiveOrigin(options))
    }
  }

  private async dispatchWithRetry<TOutput>(
    source: TokenSource,
    url: string,
    cmd: GeoPlacesCommand,
    options?: SendOptions,
  ): Promise<TOutput> {
    const token = await source.get()
    if (!token) throw noTokenAvailable()

    try {
      return await this.dispatch<TOutput>(url, token, cmd, options)
    } catch (err) {
      if (!isTokenRejected(err)) throw err

      // One retry, and only when the replacement is genuinely a different
      // token. That single comparison covers every source: a fixed `token`
      // string, a caller `getToken` that ignores `forceRefresh`, and a cached
      // token the API has revoked before its `exp` all hand back what we
      // already sent — and re-sending it would be a second doomed request, and
      // a second billed one.
      const fresh = await source.get(true)
      if (!fresh || fresh === token) throw err

      log('401 on a token the API no longer accepts — retrying once, refreshed')
      return await this.dispatch<TOutput>(url, fresh, cmd, options)
    }
  }

  private dispatch<TOutput>(
    url: string,
    token: string,
    cmd: GeoPlacesCommand,
    options?: SendOptions,
  ): Promise<TOutput> {
    // The token is resolved before the request is shaped, so the precision this
    // application is entitled to is available (api#65). Absent claim -> the
    // 3 dp floor, which is what every application gets until one is configured
    // otherwise. Recomputed per attempt because a refreshed token may carry
    // different claims.
    const { biasDecimals } = readAppConfigClaims(token)
    const input = roundPositionFields(cmd.input, biasDecimals)

    // Every system header is set exactly ONCE, and the caller's own spelling of
    // each is dropped first.
    //
    // Spreading them over the caller's record is not enough, because fetch's
    // Headers fill APPENDS rather than replaces: a caller's lowercase key
    // survives beside the canonical one and both go on the wire. For Origin
    // that produced `Origin: default, per-call`, which the API's exact-match
    // domain check rejects (observed: 403 OriginNotAllowedException) — and two
    // keys with the SAME value fared no better, `Origin: x, x`. For
    // Authorization it is worse than a failed override: `{ authorization:
    // 'Bearer not-yours' }` went out as `Bearer not-yours, Bearer <real>`,
    // corrupting the token rather than being ignored by it.
    //
    // Origin's value comes from `effectiveOrigin`, so a per-call header still
    // beats the connector default — it is the DUPLICATE that is removed, not
    // the caller's intent.
    const origin = this.effectiveOrigin(options)
    const headers: Record<string, string> = {
      ...withoutHeaders(options?.headers, SYSTEM_HEADERS),
      ...(origin ? { Origin: origin } : {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }

    log('Sending %s request to %s', cmd.constructor?.name, url)
    return requestJson<TOutput>(
      url,
      { method: 'POST', headers, body: JSON.stringify(input) },
      options,
    )
  }
}

function requireApiUrl(explicit?: string): string {
  const apiUrl = resolveApiUrl(explicit)
  if (!apiUrl) {
    throw new LocationServiceException({
      code: 'ValidationException',
      message:
        'No API URL. Pass `apiUrl` to the LocationServiceConnector constructor ' +
        'or set LOCATION_API_URL.',
      details: { source: 'client' },
    })
  }
  return apiUrl
}

function noTokenAvailable(): LocationServiceException {
  return new LocationServiceException({
    code: 'InvalidCredentialsException',
    message: 'No token available — check clientId/clientSecret configuration',
    details: { source: 'client' },
  })
}
