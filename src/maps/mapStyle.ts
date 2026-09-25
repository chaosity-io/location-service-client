import type { StyleSpecification } from 'maplibre-gl'

import { noTokenAvailable } from '../transport/errors.js'
import type { RequestOptions } from '../transport/http.js'
import { requestJson } from '../transport/http.js'
import type {
  Buildings,
  ColorScheme,
  ContourDensity,
  MapStyle,
  PoiDensity,
  StylePoiCategory,
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
 *
 * The options tagged `@planFeature` are PLAN FEATURES, each tag naming its
 * feature (#55). An application whose plan does not include one is
 * refused 403 `FeatureNotEntitledException` — `isFeatureNotEntitled` on the
 * error — before anything is drawn, and the message names the feature and the
 * option that asked for it. `colorScheme`, `poiDensity` and `poiCategories`
 * are open to every plan, as are the Standard and Monochrome styles. Which plan
 * includes which feature is not this package's to say, since it can change
 * without a release: see https://chaosity.cloud/pricing.
 */
export interface MapStyleOptions {
  /** Color scheme for the map (default: Light). Not applicable to Satellite/Hybrid styles. */
  colorScheme?: ColorScheme
  /**
   * ISO 3166-1 alpha-3 country code for political boundary perspective
   * (e.g. 'IND', 'TUR').
   *
   * Refused on a plan without it: 403 `FeatureNotEntitledException` (see
   * `FEATURE_NOT_ENTITLED`).
   *
   * @planFeature political-view
   */
  politicalView?: string
  /**
   * Terrain overlay type.
   *
   * Refused on a plan without it: 403 `FeatureNotEntitledException` (see
   * `FEATURE_NOT_ENTITLED`).
   *
   * @planFeature terrain
   */
  terrain?: Terrain
  /**
   * Enable 3D building extrusions.
   *
   * Refused on a plan without it: 403 `FeatureNotEntitledException` (see
   * `FEATURE_NOT_ENTITLED`).
   *
   * @planFeature buildings
   */
  buildings?: Buildings
  /**
   * Elevation contour line density.
   *
   * All of High, Low and Medium work. This was previously typed as `'Medium'`
   * alone, documented as "the only value currently supported by the AWS SDK",
   * which was wrong — the other two were confirmed against the live API.
   *
   * Refused on a plan without it: 403 `FeatureNotEntitledException` (see
   * `FEATURE_NOT_ENTITLED`).
   *
   * @planFeature contours
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
   *
   * Refused on a plan without it: 403 `FeatureNotEntitledException` (see
   * `FEATURE_NOT_ENTITLED`).
   *
   * @planFeature traffic
   */
  traffic?: TrafficMode
  /**
   * Travel mode overlays for routing-specific features.
   *
   * Refused on a plan without it: 403 `FeatureNotEntitledException` (see
   * `FEATURE_NOT_ENTITLED`).
   *
   * @planFeature travel-modes
   */
  travelModes?: TravelMode[]
  /**
   * How many points of interest to draw; `Off` draws none. Standard and
   * Hybrid only — Monochrome and Satellite answer 400.
   */
  poiDensity?: PoiDensity
  /**
   * Draw only these categories of point of interest. Standard and Hybrid
   * only, like `poiDensity`.
   */
  poiCategories?: StylePoiCategory[]
}

/**
 * Build a map style descriptor URL for the Location Service API.
 *
 * MapLibre fetches this URL itself, so a refusal of it never reaches this
 * package's error type — see `fetchMapStyle` for what it looks like instead.
 *
 * @param apiUrl - Base URL of the Location Service API
 * @param mapStyle - Map style name: 'Standard' or 'Monochrome', or 'Satellite'
 *   or 'Hybrid', which need the `satellite` plan feature (see `MAP_STYLES`)
 * @param options - Optional style parameters; those tagged `@planFeature` need
 *   that feature of the application's plan
 * @returns Full style descriptor URL
 *
 * @example
 * const url = buildMapStyleUrl(API_URL, 'Standard', { colorScheme: 'Dark' })
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
  if (options.poiDensity) params.set('poi-density', options.poiDensity)
  if (options.poiCategories?.length)
    params.set('poi-categories', options.poiCategories.join(','))

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
 * A REFUSED OPTION. This is the path that surfaces a plan refusal as this
 * package's error: an option tagged `@planFeature` that the application's plan
 * does not include rejects with a `LocationServiceException` whose
 * `isFeatureNotEntitled` is true (code `FeatureNotEntitledException`, status
 * 403), and whose message names the feature and the option. What MapLibre
 * fetches for itself — a URL from `buildMapStyleUrl` handed to `setStyle`, and
 * the tiles — is refused the same way when it asks for a feature the plan
 * lacks, but the refusal arrives as a MapLibre `error` event instead:
 * `event.error.status` is 403, and `event.error.body` is a `Blob` holding the
 * same `{ message, code }` JSON.
 *
 * @param apiUrl - Base URL of the Location Service API
 * @param mapStyle - Map style name: 'Standard' or 'Monochrome', or 'Satellite'
 *   or 'Hybrid', which need the `satellite` plan feature (see `MAP_STYLES`)
 * @param getToken - Callback returning the current auth token
 * @param options - Style options; `language` is applied to the descriptor, all
 *   others become URL params. Those tagged `@planFeature` need that feature of
 *   the application's plan
 * @param request - Transport options: `signal` to cancel, `timeoutMs`, `overallTimeoutMs`, `retry`
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
  request: RequestOptions = {},
): Promise<StyleSpecification> {
  const { language, ...styleOptions } = options
  const url = buildMapStyleUrl(apiUrl, mapStyle, styleOptions)

  const token = getToken()
  // `Bearer undefined` used to go out here, and came back as a 401 the caller
  // had to work backwards from — a whole round trip for a request that was
  // never going to succeed (#37).
  if (!token) {
    throw noTokenAvailable(
      'getToken() returned nothing, so no style request was sent. Check the token provider has finished initialising.',
    )
  }

  // Through the shared transport, not a bare fetch: this gets the same
  // per-attempt timeout, overall budget, cancellation and retry as every other
  // call in the package, and the same error type on the way out. It also keeps
  // the API's own message, which is the whole point of reading the body — for
  // a style request that sentence is Amazon's, forwarded verbatim by
  // location-service-api#89:
  //
  //   400 "Traffic is not supported for style."
  //   400 "light is not a supported color scheme for style Standard."
  //
  // This used to throw `Failed to fetch map style: 400`, discarding all of it
  // two lines before anyone could read it — the same defect #89 fixed in the
  // API, one layer up.
  const style = await requestJson<StyleSpecification>(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
    request,
  )

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
