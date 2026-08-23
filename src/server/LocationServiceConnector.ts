import debug from 'debug'
import { LocationServiceException } from '../errors/LocationServiceException'
import { resolveEndpoint } from '../transport/endpoints'
import type { RequestOptions } from '../transport/http'
import { requestJson } from '../transport/http'
import type { GeoPlacesCommand } from '../types'
import { roundPositionFields } from '../utils/roundPosition'
import type { ServerClientConfig } from './getClientConfig'
import { getClientConfig } from './getClientConfig'

const log = debug('location-client:connector')

export interface ConnectorConfig {
  apiUrl?: string
  token?: string
  getToken?: () => Promise<{ token: string }>
  /**
   * Sent as the `Origin` header on every request. The API requires an Origin it
   * recognises on every data request and answers 403 without one, so every
   * caller was setting it by hand on each `send`; this does it once.
   */
  origin?: string
}

export interface SendOptions extends RequestOptions {
  headers?: Record<string, string>
}

/**
 * LocationServiceConnector — server-side connector for the Location Service API.
 *
 * Backend-to-backend: automatic configuration from the environment, server-side
 * token management, and the same transport (timeout, cancellation, retry) as the
 * browser client.
 *
 * @example
 * ```typescript
 * const connector = new LocationServiceConnector({ origin: 'https://app.example.com' })
 * const result = await connector.send(new SearchTextCommand({ QueryText: 'Space Needle' }))
 * ```
 */
export class LocationServiceConnector {
  private configPromise: Promise<ServerClientConfig | ConnectorConfig>
  private origin?: string
  public readonly serviceId: string = 'Geo Places'

  constructor(config?: ConnectorConfig) {
    this.configPromise = config ? Promise.resolve(config) : getClientConfig()
    this.origin = config?.origin
  }

  async send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput> {
    const config = await this.configPromise

    let token: string | undefined
    if ('getToken' in config && typeof config.getToken === 'function') {
      const result = await config.getToken()
      token = result
        ? typeof result === 'string'
          ? result
          : result.token
        : undefined
    } else {
      token = (config as ConnectorConfig).token
    }

    if (!token) {
      throw new LocationServiceException({
        code: 'InvalidCredentialsException',
        message:
          'No token available — check clientId/clientSecret configuration',
        details: { source: 'client' },
      })
    }

    const cmd = command as unknown as GeoPlacesCommand
    const endpoint = resolveEndpoint(cmd)
    const input = roundPositionFields(cmd.input)

    // Caller headers first so the system ones below cannot be overridden, but an
    // explicit per-call Origin still beats the connector-wide default.
    const headers: Record<string, string> = {
      ...(this.origin ? { Origin: this.origin } : {}),
      ...(options?.headers ?? {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }

    log('Sending %s request to %s', cmd.constructor?.name, endpoint)
    return requestJson<TOutput>(
      `${config.apiUrl}${endpoint}`,
      { method: 'POST', headers, body: JSON.stringify(input) },
      options,
    )
  }
}
