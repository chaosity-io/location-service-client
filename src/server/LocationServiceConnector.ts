import {
  AutocompleteCommand,
  GeocodeCommand,
  GetPlaceCommand,
  ReverseGeocodeCommand,
  SearchNearbyCommand,
  SearchTextCommand,
  SuggestCommand,
} from '@aws-sdk/client-geo-places'
import debug from 'debug'
import { LocationServiceException } from '../errors/LocationServiceException'
import type { GeoPlacesCommand } from '../types'
import { roundPositionFields } from '../utils/roundPosition'
import type { ServerClientConfig } from './getClientConfig'
import { getClientConfig } from './getClientConfig'

const log = debug('location-client:connector')

export interface ConnectorConfig {
  apiUrl?: string
  token?: string
  getToken?: () => Promise<{ token: string }>
}

export interface SendOptions {
  headers?: Record<string, string>
}

/**
 * LocationServiceConnector - Server-side connector for Location Service API
 *
 * Optimized for backend-to-backend communication with:
 * - Automatic configuration from environment variables
 * - Automatic Origin header handling
 * - Server-side token management
 * - Enhanced error handling
 *
 * Uses AWS SDK command classes with Bearer token authentication.
 *
 * @example
 * ```typescript
 * // Auto-detect from environment
 * const connector = new LocationServiceConnector()
 *
 * // Or provide explicit config
 * const connector = new LocationServiceConnector({
 *   apiUrl: 'https://api.example.com',
 *   token: 'your-token'
 * })
 *
 * // Send with custom headers (including Origin)
 * const result = await connector.send(
 *   new SearchTextCommand({ QueryText: 'Space Needle' }),
 *   { headers: { 'Origin': req.headers.origin } }
 * )
 * ```
 */
export class LocationServiceConnector {
  private configPromise: Promise<ServerClientConfig | ConnectorConfig>
  public readonly serviceId: string = 'Geo Places'

  constructor(config?: ConnectorConfig) {
    this.configPromise = config ? Promise.resolve(config) : getClientConfig()
  }

  async send<TOutput>(
    command: GeoPlacesCommand,
    options?: SendOptions,
  ): Promise<TOutput> {
    const config = await this.configPromise

    // Get token - ConnectorConfig may have getToken, ServerClientConfig has static token
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
      throw new Error('No token available')
    }

    const endpoint = this.getEndpoint(command)
    const url = `${config.apiUrl}${endpoint}`
    const commandName = command.constructor.name
    const input = roundPositionFields(command.input)

    log('Sending %s request to %s', commandName, endpoint)
    const startTime = Date.now()

    // Merge headers: user headers, then system headers override
    const headers: Record<string, string> = {
      ...(options?.headers || {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    })

    const duration = Date.now() - startTime

    if (!response.ok) {
      const errorText = await response.text()
      log(
        'Request failed: %s %s (%dms)',
        response.status,
        response.statusText,
        duration,
      )

      let errorMessage = `API request failed: ${response.statusText}`
      let errorCode = 'ServiceException'
      let requestId: string | undefined

      try {
        const errorData = JSON.parse(errorText)
        if (errorData.message) errorMessage = errorData.message
        if (errorData.code) errorCode = errorData.code
        if (errorData.requestId) requestId = errorData.requestId
      } catch {
        if (errorText) errorMessage = errorText
      }

      throw new LocationServiceException({
        message: errorMessage,
        code: errorCode,
        statusCode: response.status,
        requestId,
      })
    }

    const result = await response.json()
    log('Request successful: %s (%dms)', response.status, duration)
    return result
  }

  private getEndpoint(command: GeoPlacesCommand): string {
    if (command instanceof AutocompleteCommand) return '/address/autocomplete'
    if (command instanceof GeocodeCommand) return '/address/geocode'
    if (command instanceof GetPlaceCommand) return '/address/place'
    if (command instanceof ReverseGeocodeCommand)
      return '/address/search/reverse-geocode'
    if (command instanceof SearchNearbyCommand) return '/address/search/nearby'
    if (command instanceof SearchTextCommand) return '/address/search/text'
    if (command instanceof SuggestCommand) return '/address/suggestion'
    throw new Error(
      `Unknown command type: ${command.constructor?.name ?? typeof command}`,
    )
  }
}
