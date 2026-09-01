// Client (Custom - uses our auth instead of AWS SigV4)
export { GeoPlacesClient } from './client/GeoPlacesClient.js'
export type { SendOptions } from './client/GeoPlacesClient.js'

// Transport options — cancellation, per-attempt timeout, overall budget, retry
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from './transport/http.js'
export type { RequestOptions } from './transport/http.js'

// Token refresh policy — shared by the server provider and the React provider
export {
  TOKEN_REFRESH_BUFFER_SECONDS,
  readTokenExpiry,
} from './auth/tokenRefresh.js'

// Errors
export { LocationServiceException } from './errors/LocationServiceException.js'
export type { LocationServiceExceptionOptions } from './errors/LocationServiceException.js'

// Re-export AWS SDK commands and types
export * from '@aws-sdk/client-geo-places'

// Re-export AWS Location Utilities (data type conversions)
export * from '@aws/amazon-location-utilities-datatypes'

// Adapters (Custom - for MapLibre integration)
export { GeoPlaces } from './adapters/GeoPlaces.js'
export type {
  GeoPlacesDetailOptions,
  GeoPlacesOptions,
} from './adapters/GeoPlaces.js'

// Maps utilities
export { createTransformRequest } from './maps/createTransformRequest.js'
export { applyMapLanguage } from './maps/mapLanguage.js'
export {
  POI_CATEGORIES,
  setAllPoiVisibility,
  setPoiVisibility,
} from './maps/mapPoi.js'
export type { PoiCategory } from './maps/mapPoi.js'
export { buildMapStyleUrl, fetchMapStyle } from './maps/mapStyle.js'
export type { MapStyleOptions } from './maps/mapStyle.js'
export {
  buildStaticMapUrl,
  fetchStaticMap,
  staticMapAccept,
} from './maps/staticMap.js'
export type { StaticMapFileName, StaticMapOptions } from './maps/staticMap.js'

// Accepted values for every map parameter, as VALUES so a picker can be built
// from them, plus the matching types. Case sensitive — see mapEnums.ts.
export {
  BUILDINGS,
  COLOR_SCHEMES,
  CONTOUR_DENSITIES,
  LABEL_SIZES,
  MAP_FEATURE_MODES,
  MAP_STYLES,
  SCALE_BAR_UNITS,
  SPRITE_VARIANTS,
  STATIC_MAP_STYLES,
  TERRAINS,
  TRAFFIC_MODES,
  TRAVEL_MODES,
} from './maps/mapEnums.js'
export type {
  Buildings,
  ColorScheme,
  ContourDensity,
  LabelSize,
  MapFeatureMode,
  MapStyle,
  ScaleBarUnit,
  SpriteVariant,
  StaticMapStyle,
  Terrain,
  TrafficMode,
  TravelMode,
} from './maps/mapEnums.js'
export { transformRequest } from './maps/Utils.js'

// Custom Types
export type { ClientConfig, GeoPlacesCommand, MapLike } from './types/index.js'
export type { AppConfigClaims } from './utils/tokenClaims.js'

// Server-only utilities are available via '@chaosity/location-client/server'
