import type { StyleSpecification } from 'maplibre-gl'

/**
 * Options for building an AWS Location Service map style URL.
 * All parameters map directly to query parameters supported by the style descriptor endpoint.
 */
export interface MapStyleOptions {
  /** Color scheme for the map (default: Light). Not applicable to Satellite/Hybrid styles. */
  colorScheme?: 'Light' | 'Dark'
  /** ISO 3166-1 alpha-3 country code for political boundary perspective (e.g. 'IND', 'TUR'). */
  politicalView?: string
  /** Terrain overlay type. */
  terrain?: 'Hillshade' | 'Terrain3D'
  /** Enable 3D building extrusions. */
  buildings?: 'Buildings3D'
  /** Elevation contour line density. */
  contourDensity?: 'Low' | 'Medium' | 'High'
  /** Enable real-time traffic flow visualization. */
  traffic?: 'All'
  /** Travel mode overlays for routing-specific features. */
  travelModes?: Array<'Truck' | 'Transit'>
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
  mapStyle: string,
  options: MapStyleOptions = {}
): string {
  const params = new URLSearchParams()

  if (options.colorScheme) params.set('color-scheme', options.colorScheme)
  if (options.politicalView) params.set('political-view', options.politicalView)
  if (options.terrain) params.set('terrain', options.terrain)
  if (options.buildings) params.set('buildings', options.buildings)
  if (options.contourDensity) params.set('contour-density', options.contourDensity)
  if (options.traffic) params.set('traffic', options.traffic)
  if (options.travelModes?.length) params.set('travel-modes', options.travelModes.join(','))

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
  mapStyle: string,
  getToken: () => string | undefined,
  options: MapStyleOptions & { language?: string } = {}
): Promise<StyleSpecification> {
  const { language, ...styleOptions } = options
  const url = buildMapStyleUrl(apiUrl, mapStyle, styleOptions)

  const token = getToken()
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    }
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch map style: ${response.status} ${response.statusText}`)
  }

  const style = await response.json() as StyleSpecification

  if (language) {
    applyLanguageToDescriptor(style, language)
  }

  return style
}

/**
 * Apply a preferred language to all symbol layers within a style descriptor object.
 * Mutates the style in place — call before passing to MapLibre.
 */
function applyLanguageToDescriptor(style: StyleSpecification, language: string): void {
  const expression =
    language === 'en'
      ? ['coalesce', ['get', 'name:en'], ['get', 'name']]
      : ['coalesce', ['get', `name:${language}`], ['get', 'name:en'], ['get', 'name']]

  for (const layer of style.layers) {
    if (layer.type === 'symbol') {
      const layout = layer.layout as Record<string, unknown> | undefined
      if (layout?.['text-field'] !== undefined) {
        layout['text-field'] = expression
      }
    }
  }
}
