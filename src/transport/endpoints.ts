import {
  AutocompleteCommand,
  GeocodeCommand,
  GetPlaceCommand,
  ReverseGeocodeCommand,
  SearchNearbyCommand,
  SearchTextCommand,
  SuggestCommand,
} from '@aws-sdk/client-geo-places'
import { LocationServiceException } from '../errors/LocationServiceException'
import type { GeoPlacesCommand } from '../types'

type CommandConstructor = new (...args: never[]) => GeoPlacesCommand

/**
 * Command class -> API path.
 *
 * Keyed on constructor IDENTITY, never on `constructor.name`: a minifier
 * rewrites class names and a string-keyed map silently stops matching in a
 * production bundle while working perfectly in dev. The server connector used
 * to carry its own `if (cmd instanceof X)` chain saying the same thing in a
 * different order — one of them was always going to drift.
 */
const ENDPOINTS = new Map<CommandConstructor, string>([
  [AutocompleteCommand, '/address/autocomplete'],
  [GeocodeCommand, '/address/geocode'],
  [GetPlaceCommand, '/address/place'],
  [ReverseGeocodeCommand, '/address/search/reverse-geocode'],
  [SearchNearbyCommand, '/address/search/nearby'],
  [SearchTextCommand, '/address/search/text'],
  [SuggestCommand, '/address/suggestion'],
])

export function resolveEndpoint(command: GeoPlacesCommand): string {
  for (const [CommandClass, endpoint] of ENDPOINTS) {
    if (command instanceof CommandClass) return endpoint
  }
  throw new LocationServiceException({
    code: 'UnknownCommandException',
    message: `Unknown command type: ${command?.constructor?.name ?? typeof command}`,
    details: { source: 'client' },
  })
}
