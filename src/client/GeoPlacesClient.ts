import debug from 'debug'
import {
  AutocompleteCommand,
  GeocodeCommand,
  GetPlaceCommand,
  ReverseGeocodeCommand,
  SearchNearbyCommand,
  SearchTextCommand,
  SuggestCommand,
} from '@aws-sdk/client-geo-places'
import { ClientConfig } from '../types'

const log = debug('location-client:api')
const logError = debug('location-client:api:error')

// Minification-safe endpoint map — uses constructor identity, not class name strings
const ENDPOINT_MAP = new Map<Function, string>([
  [AutocompleteCommand, '/address/autocomplete'],
  [GeocodeCommand, '/address/geocode'],
  [GetPlaceCommand, '/address/place'],
  [ReverseGeocodeCommand, '/address/search/reverse-geocode'],
  [SearchNearbyCommand, '/address/search/nearby'],
  [SearchTextCommand, '/address/search/text'],
  [SuggestCommand, '/address/suggestion'],
])

/**
 * GeoPlacesClient - AWS Location Service compatible client with custom auth
 *
 * Uses AWS SDK command classes but replaces SigV4 auth with Bearer token.
 * All request/response types are identical to AWS Location Service.
 *
 * Pass `getToken` in config to support live token refresh without recreating the client.
 */
export class GeoPlacesClient {
  private clientConfig: ClientConfig
  public readonly config: { serviceId: string }

  constructor(config: ClientConfig) {
    this.clientConfig = config
    this.config = { serviceId: 'Geo Places' }
  }

  async send<TInput, TOutput>(command: TInput): Promise<TOutput> {
    const endpoint = this.getEndpoint(command)
    const url = `${this.clientConfig.apiUrl}${endpoint}`
    const commandName = (command as any).constructor.name
    const input = (command as any).input

    // Prefer getToken callback (live ref) over static token string
    const token = this.clientConfig.getToken?.() ?? this.clientConfig.token

    log('Sending %s to %s', commandName, endpoint)
    const startTime = Date.now()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    })

    const duration = Date.now() - startTime

    if (!response.ok) {
      const errorText = await response.text()
      logError('Request failed: %s %s (%dms)', response.status, response.statusText, duration)

      let errorMessage = `API request failed: ${response.statusText}`
      try {
        const errorData = JSON.parse(errorText)
        if (errorData.message) errorMessage = errorData.message
      } catch {
        if (errorText) errorMessage = errorText
      }

      throw new Error(errorMessage)
    }

    const result = await response.json()
    log('Request successful: %s (%dms)', response.status, duration)
    return result
  }

  private getEndpoint(command: any): string {
    for (const [CommandClass, endpoint] of ENDPOINT_MAP) {
      if (command instanceof CommandClass) return endpoint
    }
    throw new Error(`Unknown command type: ${(command as any).constructor?.name ?? typeof command}`)
  }
}
