// Client (Custom - uses our auth instead of AWS SigV4)
export { GeoPlacesClient } from './client/GeoPlacesClient'

// Errors
export { LocationServiceException } from './errors/LocationServiceException'
export type { LocationServiceExceptionOptions } from './errors/LocationServiceException'

// Re-export AWS SDK commands and types
export * from '@aws-sdk/client-geo-places'

// Re-export AWS Location Utilities (data type conversions)
export * from '@aws/amazon-location-utilities-datatypes'

// Adapters (Custom - for MapLibre integration)
export { GeoPlaces } from './adapters/GeoPlaces'

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
export { transformRequest } from './maps/Utils'

// Custom Types
export type { ClientConfig, GeoPlacesCommand, MapLike } from './types'

// Server-only utilities are available via '@chaosity/location-client/server'
