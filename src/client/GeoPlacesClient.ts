import debug from 'debug'
import { resolveEndpoint } from '../transport/endpoints.js'
import { isTokenRejected } from '../transport/errors.js'
import type { RequestOptions } from '../transport/http.js'
import { requestJson } from '../transport/http.js'
import type { ClientConfig, GeoPlacesCommand } from '../types/index.js'
import { roundPositionFields } from '../utils/roundPosition.js'
import type { AppConfigClaims } from '../utils/tokenClaims.js'
import { readAppConfigClaims } from '../utils/tokenClaims.js'

const log = debug('location-client:api')

export type SendOptions = RequestOptions

/**
 * GeoPlacesClient — AWS Location Service compatible client with custom auth.
 *
 * Uses AWS SDK command classes but replaces SigV4 with a Bearer token. All
 * request and response types are identical to AWS Location Service.
 *
 * Pass `getToken` in config for live refresh without recreating the client.
 */
export class GeoPlacesClient {
  private clientConfig: ClientConfig
  public readonly config: { serviceId: string }

  constructor(config: ClientConfig) {
    this.clientConfig = config
    this.config = { serviceId: 'Geo Places' }
  }

  /**
   * This application's own configuration, as carried on the access token
   * (api#65) — bias precision, and the countries it is scoped to.
   *
   * Provided so an application can SHOW its own settings: populate a country
   * selector with the markets it actually serves, label a settings screen,
   * and so on. Being a few minutes stale is cosmetic for that.
   *
   * It is not an entitlement check. See AppConfigClaims for why acting on
   * `countries` client-side makes requests fail that would otherwise succeed.
   *
   * Returns `{}` when the token carries no application config, which is the
   * case until one is configured in the portal.
   */
  getAppConfig(): AppConfigClaims {
    return readAppConfigClaims(this.currentToken())
  }

  /** Prefer the getToken callback (live ref) over a static token string. */
  private currentToken(): string | undefined {
    return this.clientConfig.getToken?.() ?? this.clientConfig.token
  }

  /**
   * @param options `signal` to cancel, `timeoutMs` per attempt, `retry: false`
   *   to disable the retry loop. Every failure throws LocationServiceException.
   */
  async send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput> {
    const cmd = command as unknown as GeoPlacesCommand
    const url = `${this.clientConfig.apiUrl}${resolveEndpoint(cmd)}`
    const token = this.currentToken()

    try {
      return await this.dispatch<TOutput>(url, token, cmd, options)
    } catch (err) {
      if (!isTokenRejected(err)) throw err

      // One shot. `refreshToken` is the only way to actually obtain a new
      // token here — `getToken` is synchronous and returns the one already in
      // hand — but it is re-read as a fallback because a provider that
      // refreshes in the background may have landed a new one while this
      // request was in flight.
      const fresh =
        (await this.clientConfig.refreshToken?.()) ?? this.currentToken()

      // Nothing new to send. Repeating the request would fail identically, and
      // be billed identically.
      if (!fresh || fresh === token) throw err

      log(
        '401 — retrying %s once with a refreshed token',
        cmd.constructor?.name,
      )
      return await this.dispatch<TOutput>(url, fresh, cmd, options)
    }
  }

  private dispatch<TOutput>(
    url: string,
    token: string | undefined,
    cmd: GeoPlacesCommand,
    options?: SendOptions,
  ): Promise<TOutput> {
    // Resolve the token BEFORE rounding: the precision this application is
    // entitled to is a claim on it (api#65). Absent claim -> the 3 dp floor.
    const { biasDecimals } = readAppConfigClaims(token)
    const input = roundPositionFields(cmd.input, biasDecimals)

    log('Sending %s to %s', cmd.constructor?.name, url)
    return requestJson<TOutput>(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input),
      },
      options,
    )
  }
}
