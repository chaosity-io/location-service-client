import debug from 'debug'
import { ClientConfig } from '../types'

const log = debug('location-client:api')
const logError = debug('location-client:api:error')




/**
 * GeoPlacesClient - AWS Location Service compatible client with custom auth
 * 
 * Uses AWS Location Client command classes but replaces SigV4 auth with Bearer token.
 * All request/response types are identical to AWS Location Service.
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

    log(`[GeoPlacesClient] Sending ${commandName} to ${endpoint}`)
    log('[GeoPlacesClient] Request body:', JSON.stringify(input, null, 2))

    log('Sending %s request to %s', commandName, endpoint)
    const startTime = Date.now()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.clientConfig.token}`
      },
      body: JSON.stringify(input)
    })

    const duration = Date.now() - startTime

    if (!response.ok) {
      const errorText = await response.text()
      log(`[GeoPlacesClient] Request failed: ${response.status} ${response.statusText}`, errorText)
      logError('Request failed: %s %s (%dms)', response.status, response.statusText, duration)

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
    log(`[GeoPlacesClient] Response (${duration}ms):`, JSON.stringify(result, null, 2))
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
