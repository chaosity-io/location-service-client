import debug from 'debug'
import { resolveEndpoint } from '../transport/endpoints'
import type { RequestOptions } from '../transport/http'
import { requestJson } from '../transport/http'
import type { ClientConfig, GeoPlacesCommand } from '../types'
import { roundPositionFields } from '../utils/roundPosition'
import type { AppConfigClaims } from '../utils/tokenClaims'
import { readAppConfigClaims } from '../utils/tokenClaims'

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
    const token = this.clientConfig.getToken?.() ?? this.clientConfig.token
    return readAppConfigClaims(token)
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
    const endpoint = resolveEndpoint(cmd)

    // Prefer the getToken callback (live ref) over a static token string.
    const token = this.clientConfig.getToken?.() ?? this.clientConfig.token

    // Resolve the token BEFORE rounding: the precision this application is
    // entitled to is a claim on it (api#65). Absent claim -> the 3 dp floor.
    const { biasDecimals } = readAppConfigClaims(token)
    const input = roundPositionFields(cmd.input, biasDecimals)

    log('Sending %s to %s', cmd.constructor?.name, endpoint)
    return requestJson<TOutput>(
      `${this.clientConfig.apiUrl}${endpoint}`,
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
