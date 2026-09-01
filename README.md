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

The Places commands, the transport and the static-map and style-URL helpers need
nothing else. The **map** features are optional peer dependencies, so install
them only if you use them:

```bash
# interactive map helpers (createTransformRequest, applyMapLanguage, POI toggles)
npm install maplibre-gl

# the MapLibre geocoder control (the GeoPlaces adapter)
npm install maplibre-gl @maplibre/maplibre-gl-geocoder
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

# Only for LocationServiceConnector: the Origin sent on every data request.
# The API answers 403 without one it recognises — see below.
LOCATION_ORIGIN=https://your-allowed-domain.example
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
import {
  GeoPlacesClient,
  SuggestCommand,
  type SuggestCommandOutput,
} from '@chaosity/location-client'

const client = new GeoPlacesClient({
  apiUrl: 'https://api.chaosity.cloud',
  token: 'your-bearer-token',
})

const response: SuggestCommandOutput = await client.send(
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

Requires the optional peers: `npm install maplibre-gl @maplibre/maplibre-gl-geocoder`

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
  refreshToken?: () => Promise<string | undefined>, // Optional: 401 self-heal
})

await client.send(command)
```

When `getToken` is provided, it is called on every request so token updates are reflected without recreating the client.

`refreshToken` covers the case `getToken` cannot. `getToken` is synchronous —
MapLibre's `transformRequest` requires that — so it can only ever return the
token already in hand, and a token the API stops accepting **before** its `exp`
(revoked, or issued against a since-rotated secret) fails every request until
the refresh buffer elapses. `refreshToken` is awaited after a 401, and the
request is retried **once** with what it returns. Return the same token, or
nothing, and no retry is sent — a request that is going to fail again is not
worth a second round trip. A 403 is never retried: a new token cannot fix an
`Origin` the application does not allow.

#### Request options

Every call in this package takes the same options object — `client.send`,
`connector.send`, `fetchMapStyle` and `fetchStaticMap` — and every failure
arrives as a `LocationServiceException`.

```typescript
await client.send(command, {
  signal, // AbortSignal — cancels mid-flight AND mid-backoff
  timeoutMs: 10_000, // per ATTEMPT
  overallTimeoutMs: 30_000, // the whole call, waits between attempts included
  retry: { maxAttempts: 3 }, // or `false` for none
})
```

`overallTimeoutMs` is the one worth setting deliberately, and it defaults to
30 s. `timeoutMs` bounds an attempt, not a call: the API answers a spent quota
with `Retry-After: 60`, and honouring that literally across two retries blocked
the caller for about two minutes — past any Lambda budget. Now no attempt gets
more time than the call has left, and a retry that would have to wait longer
than the remaining budget is not made at all. You get the API's own error back
instead, `retryAfterMs` intact, so you can queue the work rather than guess.

The map helpers take them as a trailing argument:

```typescript
const style = await fetchMapStyle(
  apiUrl,
  'Standard',
  getToken,
  { language: 'fr' },
  { signal },
)
const blob = await fetchStaticMap(
  apiUrl,
  { width: 640, height: 400, center },
  getToken,
  { signal },
)
```

**A call with no token is refused locally rather than sent.** Every path that
builds an `Authorization` header checks first, so a token source that has not
produced one yet raises `InvalidCredentialsException` instead of putting
`Bearer undefined` on the wire — which could only ever come back a 401, a round
trip spent to be told what you already know. `GeoPlacesClient` asks `refreshToken` first, so a
client whose token simply has not arrived yet still works.

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

// The API has rejected a token that has not reached its exp — revoked in the
// portal, or issued against a client secret that has since been rotated.
const replacement = await getClientConfig({ forceRefresh: true })
```

The return value is **plain data** — no methods, no closures — so it can be
returned straight out of a Next.js Server Action to a Client Component. It is
therefore a snapshot: the token in it stops working at its `expiresAt`, and the
caller asks for another. For a long-lived server process that should just keep
working, use `LocationServiceConnector`, which holds a live token source and
refreshes for you.

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

Server-side connector for backend-to-backend API calls. It **completes** its
configuration from the environment rather than replacing it, so you supply only
the parts the environment does not have:

```typescript
import { LocationServiceConnector } from '@chaosity/location-client/server'

// apiUrl + credentials from LOCATION_API_URL / LOCATION_CLIENT_ID /
// LOCATION_CLIENT_SECRET; Origin from here. Set LOCATION_ORIGIN as well and
// `new LocationServiceConnector()` needs no arguments at all.
const connector = new LocationServiceConnector({
  origin: 'https://your-allowed-domain.example',
})

const result = await connector.send(
  new SuggestCommand({ QueryText: 'Vancouver' }),
)
```

**Every data request needs an `Origin` the service recognises, and the API
answers 403 without one** — server-to-server calls included, not just browsers.
In a browser the browser sets it; here you do, with `origin` above,
`LOCATION_ORIGIN`, or a per-call header (`send(cmd, { headers: { Origin } })`,
which wins over both). `/auth/token` is the one endpoint exempt.

A connector configured this way keeps working indefinitely: it holds a live
token source, refreshes before expiry, and retries once with a new token if the
API rejects the one it sent. Pass an explicit `token` instead and you opt out of
all of that — it is a fixed string, and it dies at its own `exp`:

```typescript
// Managing credentials yourself: an explicit token source wins outright, and
// the environment is not consulted.
const connector = new LocationServiceConnector({
  apiUrl,
  origin: 'https://your-allowed-domain.example',
  getToken: (forceRefresh) => provider.getToken(forceRefresh),
})
```

## Cache-Friendly Position Rounding

`BiasPosition` coordinates are automatically rounded before each API request, to
whatever precision your application is entitled to — a `biasDecimals` claim on
the access token, defaulting to **3 decimal places** (~110 m) when the token
carries none. This maximizes cache hits across nearby users without affecting
result quality — bias is approximate by nature.

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
import type { SuggestCommandOutput } from '@chaosity/location-client'

const response: SuggestCommandOutput = await client.send(
  new SuggestCommand({ QueryText: 'Vancouver' }),
)
```

## License

MIT
