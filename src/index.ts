// Client (Custom - uses our auth instead of AWS SigV4)
export { GeoPlacesClient } from './client/GeoPlacesClient'
export type { SendOptions } from './client/GeoPlacesClient'

// Transport options — cancellation, per-attempt timeout, retry policy
export { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS } from './transport/http'
export type { RequestOptions } from './transport/http'

// Token refresh policy — shared by the server provider and the React provider
export {
  TOKEN_REFRESH_BUFFER_SECONDS,
  readTokenExpiry,
} from './auth/tokenRefresh'

// Errors
export { LocationServiceException } from './errors/LocationServiceException'
export type { LocationServiceExceptionOptions } from './errors/LocationServiceException'

// Re-export AWS SDK commands and types
export * from '@aws-sdk/client-geo-places'

// Re-export AWS Location Utilities (data type conversions)
export * from '@aws/amazon-location-utilities-datatypes'

// Adapters (Custom - for MapLibre integration)
export { GeoPlaces } from './adapters/GeoPlaces'
export type {
  GeoPlacesDetailOptions,
  GeoPlacesOptions,
} from './adapters/GeoPlaces'

// Maps utilities
export { createTransformRequest } from './maps/createTransformRequest'
export { applyMapLanguage } from './maps/mapLanguage'
export {
  POI_CATEGORIES,
  setAllPoiVisibility,
  setPoiVisibility,
} from './maps/mapPoi'
export type { PoiCategory } from './maps/mapPoi'
export { buildMapStyleUrl, fetchMapStyle } from './maps/mapStyle'
export type { MapStyleOptions } from './maps/mapStyle'

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
} from './maps/mapEnums'
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
} from './maps/mapEnums'
export { transformRequest } from './maps/Utils'

// Custom Types
export type { ClientConfig, GeoPlacesCommand, MapLike } from './types'
export type { AppConfigClaims } from './utils/tokenClaims'

// Server-only utilities are available via '@chaosity/location-client/server'
