import debug from 'debug'
import { resolveEndpoint } from '../transport/endpoints'
import type { RequestOptions } from '../transport/http'
import { requestJson } from '../transport/http'
import type { ClientConfig, GeoPlacesCommand } from '../types'
import { roundPositionFields } from '../utils/roundPosition'

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
   * @param options `signal` to cancel, `timeoutMs` per attempt, `retry: false`
   *   to disable the retry loop. Every failure throws LocationServiceException.
   */
  async send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput> {
    const cmd = command as unknown as GeoPlacesCommand
    const endpoint = resolveEndpoint(cmd)
    const input = roundPositionFields(cmd.input)

    // Prefer the getToken callback (live ref) over a static token string.
    const token = this.clientConfig.getToken?.() ?? this.clientConfig.token

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
