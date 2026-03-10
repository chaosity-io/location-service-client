// Client (Custom - uses our auth instead of AWS SigV4)
export { GeoPlacesClient } from './client/GeoPlacesClient'

// Re-export AWS SDK commands and types
export * from '@aws-sdk/client-geo-places'

// Re-export AWS Location Utilities (data type conversions)
export * from '@aws/amazon-location-utilities-datatypes'

// Adapters (Custom - for MapLibre integration)
export { GeoPlaces } from './adapters/GeoPlaces'

// Maps utilities
export { createTransformRequest } from './maps/createTransformRequest'
export { transformRequest } from './maps/Utils'
export { buildMapStyleUrl, fetchMapStyle } from './maps/mapStyle'
export type { MapStyleOptions } from './maps/mapStyle'
export { applyMapLanguage } from './maps/mapLanguage'
export { setPoiVisibility, setAllPoiVisibility, POI_CATEGORIES } from './maps/mapPoi'
export type { PoiCategory } from './maps/mapPoi'

// Custom Types
export type { ClientConfig } from './types'

// Server-only utilities are available via '@chaosity/location-client/server'
