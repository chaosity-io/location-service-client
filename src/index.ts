// Auth (Custom - only difference from AWS SDK)
export { TokenProvider } from './auth/TokenProvider'
export type { TokenResponse, TokenProviderConfig } from './auth/TokenProvider'

// Client (Custom - uses our auth instead of AWS SigV4)
export { GeoPlacesClient } from './client/GeoPlacesClient'



// Re-export AWS SDK commands and types
export * from '@aws-sdk/client-geo-places'

// Re-export AWS Location Utilities (data type conversions)
export * from '@aws/amazon-location-utilities-datatypes'

// Adapters (Custom - for MapLibre integration)
export { GeoPlaces } from './adapters/GeoPlaces'

// Custom Types
export type { ClientConfig } from './types'

// Server-only utilities
export { getClientConfig } from './server/getClientConfig'
export type { ServerAuthConfig } from './server/getClientConfig'
