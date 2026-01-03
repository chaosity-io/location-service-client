import { ClientConfig } from '../types'
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
import { getClientConfig, ServerClientConfig } from './getClientConfig'

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
    this.configPromise = config
      ? Promise.resolve(config)
      : getClientConfig()
  }

  async send<TInput, TOutput>(command: TInput, options?: SendOptions): Promise<TOutput> {
    const config = await this.configPromise

    // Get token - ConnectorConfig may have getToken, ServerClientConfig has static token
    const token = 'getToken' in config && config.getToken
      ? (await config.getToken()).token
      : config.token

    if (!token) {
      throw new Error('No token available')
    }

    const endpoint = this.getEndpoint(command)
    const url = `${config.apiUrl}${endpoint}`
    const commandName = (command as any).constructor.name
    const input = (command as any).input

    log('Sending %s request to %s', commandName, endpoint)
    const startTime = Date.now()

    // Merge headers: user headers, then system headers override
    const headers: Record<string, string> = {
      ...(options?.headers || {}),
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input)
    })

    const duration = Date.now() - startTime

    if (!response.ok) {
      const errorText = await response.text()
      log('Request failed: %s %s (%dms)', response.status, response.statusText, duration)

      // Try to parse error message from response
      let errorMessage = `API request failed: ${response.statusText}`
      try {
        const errorData = JSON.parse(errorText)
        if (errorData.message) {
          errorMessage = errorData.message
        }
      } catch {
        // If not JSON, use raw text if available
        if (errorText) errorMessage = errorText
      }

      throw new Error(errorMessage)
    }

    const result = await response.json()
    log('Request successful: %s (%dms)', response.status, duration)
    return result
  }

  private getEndpoint(command: any): string {
    const commandName = command.constructor.name

    switch (commandName) {
      case 'AutocompleteCommand':
        return '/address/autocomplete'
      case 'GeocodeCommand':
        return '/address/geocode'
      case 'GetPlaceCommand':
        return '/address/place'
      case 'ReverseGeocodeCommand':
        return '/address/search/reverse-geocode'
      case 'SearchNearbyCommand':
        return '/address/search/nearby'
      case 'SearchTextCommand':
        return '/address/search/text'
      case 'SuggestCommand':
        return '/address/suggestion'
      default:
        throw new Error(`Unknown command type: ${commandName}`)
    }
  }
}
