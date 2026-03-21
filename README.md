# @chaosity/location-client

AWS Location Service compatible client with custom Bearer token authentication.

## Security Warning

**This package contains server-side authentication utilities that require client credentials.**

- `TokenProvider` and `getClientConfig()` are **SERVER-SIDE ONLY** (import from `@chaosity/location-client/server`)
- They require `clientId` and `clientSecret` which must **NEVER** be exposed to browsers
- Only use these in:
  - Node.js servers
  - Next.js Server Actions (`'use server'`)
  - Next.js API routes
  - Backend services

**For React applications**, use [`@chaosity/location-client-react`](https://www.npmjs.com/package/@chaosity/location-client-react) which handles authentication and token refresh safely.

## Installation

```bash
npm install @chaosity/location-client
```

## Key Features

- **Custom Authentication**: Uses Bearer tokens instead of AWS SigV4
- **AWS SDK Commands**: Full access to all AWS Location Service commands
- **Data Type Utilities**: Built-in GeoJSON conversion utilities
- **MapLibre Integration**: Adapter for MapLibre GL Geocoder and `createTransformRequest` helper
- **Map Style Control**: Fetch and customize map style descriptors with terrain, 3D buildings, traffic, and more
- **Map Language**: Switch map label language client-side with zero API calls
- **POI Layer Control**: Toggle point-of-interest categories on/off by layer
- **Server Utilities**: `getClientConfig()` with auto-env detection and token caching

## Quick Start

### Server-Side: Get Config with Auto-Authentication

The simplest way to authenticate server-side. Reads credentials from environment variables automatically.

```typescript
// app/actions/location.ts
'use server'

import { getClientConfig } from '@chaosity/location-client/server'

export async function getLocationConfig() {
  // Auto-reads LOCATION_API_URL, LOCATION_CLIENT_ID, LOCATION_CLIENT_SECRET
  return await getClientConfig()
}
```

Set these environment variables:

```bash
LOCATION_API_URL=https://api.chaosity.cloud
LOCATION_CLIENT_ID=your-client-id
LOCATION_CLIENT_SECRET=your-client-secret
```

Or pass credentials explicitly:

```typescript
const config = await getClientConfig({
  apiUrl: 'https://api.chaosity.cloud',
  clientId: process.env.MY_CLIENT_ID!,
  clientSecret: process.env.MY_SECRET!,
})
// config = { apiUrl, token, expiresAt }
```

### Client-Side: Using the GeoPlacesClient

```typescript
import { GeoPlacesClient, SuggestCommand } from '@chaosity/location-client'

const client = new GeoPlacesClient({
  apiUrl: 'https://api.chaosity.cloud',
  token: 'your-bearer-token',
})

const response = await client.send(
  new SuggestCommand({ QueryText: 'Vancouver', MaxResults: 5 }),
)
```

### MapLibre Map Integration

Use `fetchMapStyle` to fetch a style descriptor with authentication and optional customization, and `createTransformRequest` to attach Bearer tokens to all subsequent tile/glyph/sprite requests:

```typescript
import {
  fetchMapStyle,
  createTransformRequest,
} from '@chaosity/location-client'
import maplibregl from 'maplibre-gl'

const style = await fetchMapStyle(apiUrl, 'Standard', getToken, {
  colorScheme: 'Dark',
  terrain: 'Terrain3D',
  buildings: 'Buildings3D',
  language: 'fr',
})

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [-123.12, 49.28],
  zoom: 10,
  maxPitch: 85,
  transformRequest: createTransformRequest(apiUrl, getToken),
})
```

### Switching Map Language

Change map label language instantly on the client side — no API calls needed:

```typescript
import { applyMapLanguage } from '@chaosity/location-client'

// Apply after the style is loaded
map.once('style.load', () => applyMapLanguage(map, 'fr'))

// Or reapply whenever the user changes language
applyMapLanguage(map, 'ja')
```

### Controlling POI Layers

Toggle point-of-interest categories on or off:

```typescript
import {
  setPoiVisibility,
  setAllPoiVisibility,
  POI_CATEGORIES,
} from '@chaosity/location-client'

// Hide transit POIs
setPoiVisibility(map, 'transit', false)

// Hide multiple categories at once
setPoiVisibility(map, ['shopping', 'business'], false)

// Hide all POIs
setAllPoiVisibility(map, false)
```

Available categories: `food_drink`, `entertainment`, `sights`, `transit`, `accommodations`, `leisure`, `shopping`, `business`, `facilities`, `areas`, `parks`.

### MapLibre Geocoder Integration

```typescript
import { GeoPlacesClient, GeoPlaces } from '@chaosity/location-client'
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder'
import maplibregl from 'maplibre-gl'

// GeoPlaces adapter takes a GeoPlacesClient instance and the map
const client = new GeoPlacesClient({ apiUrl, token })
const geoPlaces = new GeoPlaces(client, map)

const geocoder = new MaplibreGeocoder(geoPlaces, {
  maplibregl,
  showResultsWhileTyping: true,
  limit: 30,
})

map.addControl(geocoder, 'top-left')

// The geocoder calls getSuggestions → searchByPlaceId internally.
// The 'result' event fires with the resolved place feature.
geocoder.on('result', (event) => {
  console.log('Selected place:', event.result)
})
```

## API Reference

### Main Exports (`@chaosity/location-client`)

#### GeoPlacesClient

Client for executing AWS Location Service commands with Bearer token auth.

```typescript
const client = new GeoPlacesClient({
  apiUrl: string,
  token: string,
  getToken?: () => string | undefined, // Optional: dynamic token getter
})

await client.send(command)
```

When `getToken` is provided, it is called on every request so token updates are reflected without recreating the client.

#### GeoPlaces Adapter

Implements the `MaplibreGeocoderApi` interface for use with `@maplibre/maplibre-gl-geocoder`. Methods are called automatically by the geocoder control.

```typescript
const client = new GeoPlacesClient({ apiUrl, token })
const geoPlaces = new GeoPlaces(client, map)

// Pass to MaplibreGeocoder — it calls these methods internally:
// geoPlaces.getSuggestions(config)    — typeahead suggestions
// geoPlaces.forwardGeocode(config)    — text to coordinates
// geoPlaces.reverseGeocode(config)    — coordinates to address
// geoPlaces.searchByPlaceId(config)   — place ID to details
```

#### createTransformRequest

Creates a MapLibre `transformRequest` function that adds Bearer auth and correct `Accept` headers.

```typescript
import { createTransformRequest } from '@chaosity/location-client'

const transformRequest = createTransformRequest(apiUrl, () => currentToken)
```

#### fetchMapStyle

Fetches the map style descriptor with Bearer auth and applies optional language to the descriptor JSON before MapLibre processes it (eliminates the visual flash that occurs when modifying layers post-load).

```typescript
import { fetchMapStyle } from '@chaosity/location-client'

const style = await fetchMapStyle(apiUrl, 'Standard', getToken, {
  colorScheme: 'Dark',
  terrain: 'Terrain3D',
  buildings: 'Buildings3D',
  contourDensity: 'Medium',
  traffic: 'All',
  travelModes: ['Truck', 'Transit'],
  language: 'fr',
})

const map = new maplibregl.Map({
  style,
  transformRequest: createTransformRequest(apiUrl, getToken),
})
```

#### buildMapStyleUrl

Builds the style descriptor URL without fetching. Useful when you want to pass the URL directly to MapLibre (e.g. without pre-applying language).

```typescript
import { buildMapStyleUrl } from '@chaosity/location-client'

const url = buildMapStyleUrl(apiUrl, 'Standard', {
  colorScheme: 'Dark',
  terrain: 'Hillshade',
})
```

#### MapStyleOptions

```typescript
interface MapStyleOptions {
  colorScheme?: 'Light' | 'Dark'
  politicalView?: string // ISO 3166-1 alpha-3 (e.g. 'IND', 'TUR')
  terrain?: 'Hillshade' | 'Terrain3D'
  buildings?: 'Buildings3D'
  contourDensity?: 'Medium' // Only 'Medium' is supported by the AWS SDK
  traffic?: 'All'
  travelModes?: Array<'Truck' | 'Transit'>
}
```

#### applyMapLanguage

Modifies symbol layer `text-field` expressions on an existing map to display labels in the specified language. No API call — operates entirely on the client.

```typescript
import { applyMapLanguage } from '@chaosity/location-client'

applyMapLanguage(map, 'fr')
```

#### POI Layer Control

```typescript
import {
  setPoiVisibility,
  setAllPoiVisibility,
  POI_CATEGORIES,
} from '@chaosity/location-client'
import type { PoiCategory } from '@chaosity/location-client'

setPoiVisibility(map, 'transit', false)
setAllPoiVisibility(map, false)
```

#### Available Commands

All AWS Location Service commands from `@aws-sdk/client-geo-places`:

```typescript
import {
  SuggestCommand,
  GeocodeCommand,
  ReverseGeocodeCommand,
  GetPlaceCommand,
  SearchTextCommand,
  SearchNearbyCommand,
} from '@chaosity/location-client'
```

#### Data Type Utilities

GeoJSON conversion utilities from `@aws/amazon-location-utilities-datatypes`:

```typescript
import {
  placeToFeatureCollection,
  routeToFeatureCollection,
  devicePositionsToFeatureCollection,
} from '@chaosity/location-client'
```

### Server Exports (`@chaosity/location-client/server`)

#### getClientConfig

Gets a client config with a fresh token. Uses a singleton `TokenProvider` internally — safe to call repeatedly (tokens are cached and refreshed automatically).

```typescript
import { getClientConfig } from '@chaosity/location-client/server'

const config = await getClientConfig()
// { apiUrl: string, token: string, expiresAt?: number }
```

#### TokenProvider

Lower-level token management with caching and deduplication.

```typescript
import { TokenProvider } from '@chaosity/location-client/server'

const provider = new TokenProvider({
  apiUrl: process.env.LOCATION_API_URL!,
  clientId: process.env.LOCATION_CLIENT_ID!,
  clientSecret: process.env.LOCATION_CLIENT_SECRET!,
})

const { success, token, expiresAt } = await provider.getToken()
```

#### LocationServiceConnector

Server-side connector for backend-to-backend API calls. Can auto-configure from environment variables when no config is passed.

```typescript
import { LocationServiceConnector } from '@chaosity/location-client/server'

const connector = new LocationServiceConnector({
  apiUrl: config.apiUrl,
  token: config.token,
})

const result = await connector.send(
  new SuggestCommand({ QueryText: 'Vancouver' }),
)
```

## Cache-Friendly Position Rounding

`BiasPosition` coordinates are automatically rounded to 2 decimal places (~1.1 km grid) before each API request. This maximizes cache hits across nearby users without affecting result quality — bias is approximate by nature.

`QueryPosition` (reverse geocode) retains full precision since it represents an exact point the user selected.

This is handled transparently in both `GeoPlacesClient` and `LocationServiceConnector` — no action needed in application code.

## Logging

The library uses the `debug` package for optional verbose logging:

```bash
# Enable all location-client logs
DEBUG=location-client:* npm run dev

# Enable only authentication logs
DEBUG=location-client:auth npm run dev

# Enable only API request logs
DEBUG=location-client:api npm run dev
```

## TypeScript Support

Full TypeScript support with types from AWS SDK:

```typescript
import type { SuggestCommandOutput } from '@aws-sdk/client-geo-places'

const response: SuggestCommandOutput = await client.send(
  new SuggestCommand({ QueryText: 'Vancouver' }),
)
```

## License

MIT
