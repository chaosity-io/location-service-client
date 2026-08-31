import type { StyleSpecification } from 'maplibre-gl'

import { parseErrorResponse } from '../transport/errors.js'
import type {
  Buildings,
  ColorScheme,
  ContourDensity,
  MapStyle,
  Terrain,
  TrafficMode,
  TravelMode,
} from './mapEnums.js'
import { labelsByName, languageExpression } from './mapLanguage.js'

/**
 * Options for building an AWS Location Service map style URL.
 * All parameters map directly to query parameters supported by the style descriptor endpoint.
 *
 * Values are CASE SENSITIVE — the API rejects a wrong-cased one with a 400 that
 * names the right spelling. Import the arrays from `mapEnums` to build pickers
 * rather than typing the values, and the case is right by construction.
 */
export interface MapStyleOptions {
  /** Color scheme for the map (default: Light). Not applicable to Satellite/Hybrid styles. */
  colorScheme?: ColorScheme
  /** ISO 3166-1 alpha-3 country code for political boundary perspective (e.g. 'IND', 'TUR'). */
  politicalView?: string
  /** Terrain overlay type. */
  terrain?: Terrain
  /** Enable 3D building extrusions. */
  buildings?: Buildings
  /**
   * Elevation contour line density.
   *
   * All of High, Low and Medium work. This was previously typed as `'Medium'`
   * alone, documented as "the only value currently supported by the AWS SDK",
   * which was wrong — the other two were confirmed against the live API.
   */
  contourDensity?: ContourDensity
  /**
   * Traffic overlay.
   *
   * `Congestion` was previously missing here, so it could not be requested from
   * TypeScript even though the API accepts it.
   *
   * Valid on its own, but NOT with every style: `Satellite` + `All` answers
   * 400 "Traffic is not supported for style." Amazon owns that rule.
   */
  traffic?: TrafficMode
  /** Travel mode overlays for routing-specific features. */
  travelModes?: TravelMode[]
}

/**
 * Build a map style descriptor URL for the Location Service API.
 *
 * @param apiUrl - Base URL of the Location Service API
 * @param mapStyle - Map style name (e.g. 'Standard', 'Monochrome', 'Satellite', 'Hybrid')
 * @param options - Optional style parameters
 * @returns Full style descriptor URL
 *
 * @example
 * const url = buildMapStyleUrl(API_URL, 'Standard', { colorScheme: 'Dark', terrain: 'Hillshade' })
 * map.setStyle(url)
 */
export function buildMapStyleUrl(
  apiUrl: string,
  mapStyle: MapStyle,
  options: MapStyleOptions = {},
): string {
  const params = new URLSearchParams()

  if (options.colorScheme) params.set('color-scheme', options.colorScheme)
  if (options.politicalView) params.set('political-view', options.politicalView)
  if (options.terrain) params.set('terrain', options.terrain)
  if (options.buildings) params.set('buildings', options.buildings)
  if (options.contourDensity)
    params.set('contour-density', options.contourDensity)
  if (options.traffic) params.set('traffic', options.traffic)
  if (options.travelModes?.length)
    params.set('travel-modes', options.travelModes.join(','))

  const qs = params.toString()
  return `${apiUrl}/maps/${mapStyle}/descriptor${qs ? `?${qs}` : ''}`
}

/**
 * Fetch the map style descriptor with authentication and apply descriptor-level modifications.
 *
 * Language is applied directly to the descriptor's layer definitions before MapLibre ever
 * processes them, eliminating the visual flash that occurs when modifying layers post-load.
 * All other style parameters (terrain, traffic, etc.) are passed as query parameters.
 *
 * The returned style object can be passed directly to `new maplibregl.Map({ style })` or
 * `map.setStyle()`. Tile, glyph, and sprite requests still go through `transformRequest`
 * for authentication — this only pre-processes the descriptor itself.
 *
 * @param apiUrl - Base URL of the Location Service API
 * @param mapStyle - Map style name (e.g. 'Standard', 'Monochrome', 'Satellite', 'Hybrid')
 * @param getToken - Callback returning the current auth token
 * @param options - Style options; `language` is applied to the descriptor, all others become URL params
 * @returns Modified MapLibre StyleSpecification object
 *
 * @example
 * const style = await fetchMapStyle(API_URL, 'Standard', getToken, { colorScheme: 'Dark', language: 'fr' })
 * const map = new maplibregl.Map({ style, transformRequest: createTransformRequest(API_URL, getToken) })
 */
export async function fetchMapStyle(
  apiUrl: string,
  mapStyle: MapStyle,
  getToken: () => string | undefined,
  options: MapStyleOptions & { language?: string } = {},
): Promise<StyleSpecification> {
  const { language, ...styleOptions } = options
  const url = buildMapStyleUrl(apiUrl, mapStyle, styleOptions)

  const token = getToken()
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    // Read the body. The API sends `{message, code, requestId}` and the message
    // is the whole point of it — for a style request it is Amazon's own
    // sentence, forwarded verbatim by location-service-api#89:
    //
    //   400 "Traffic is not supported for style."
    //   400 "light is not a supported color scheme for style Standard."
    //
    // This used to throw `Failed to fetch map style: 400`, discarding all of it
    // two lines before anyone could read it — the same defect #89 fixed in the
    // API, one layer up. Reuses parseErrorResponse so a style failure arrives as
    // the same LocationServiceException as every other call in this package,
    // with `code`, `statusCode` and `requestId` intact.
    throw parseErrorResponse(
      response.status,
      response.statusText,
      await response.text(),
      response.headers,
    )
  }

  const style = (await response.json()) as StyleSpecification

  if (language) {
    applyLanguageToDescriptor(style, language)
  }

  return style
}

/**
 * Apply a preferred language to the name labels within a style descriptor.
 * Mutates the style in place — call before passing to MapLibre.
 *
 * Only a `text-field` that reads a name property is rewritten. House numbers
 * (`addr_housenumber`) and road shields (`shield_text`) used to be rewritten
 * too, and vanished from every map that asked for a language (#28); the rule
 * lives in `labelsByName` so this and `applyMapLanguage` cannot disagree.
 */
function applyLanguageToDescriptor(
  style: StyleSpecification,
  language: string,
): void {
  const expression = languageExpression(language)

  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue
    const layout = layer.layout as Record<string, unknown> | undefined
    if (layout?.['text-field'] === undefined) continue
    if (!labelsByName(layout['text-field'])) continue
    layout['text-field'] = expression
  }
}
