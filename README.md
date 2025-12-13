# @chaosity/location-client

AWS Location Service compatible client with custom Bearer token authentication.

## ⚠️ Security Warning

**This package contains server-side authentication utilities that require client credentials.**

- `TokenProvider` and `getClientConfig()` are **SERVER-SIDE ONLY**
- They require `clientId` and `clientSecret` which must **NEVER** be exposed to browsers
- Only use these in:
  - Node.js servers
  - Next.js Server Actions (`'use server'`)
  - Next.js API routes
  - Backend services

**For React applications**, use [`@chaosity/location-client-react`](https://www.npmjs.com/package/@chaosity/location-client-react) which handles authentication safely.

## Installation

```bash
npm install @chaosity/location-client
```

## Key Features

- **Custom Authentication**: Uses Bearer tokens instead of AWS SigV4
- **AWS SDK Commands**: Full access to all AWS Location Service commands
- **Data Type Utilities**: Built-in GeoJSON conversion utilities
- **MapLibre Integration**: Adapter for MapLibre GL Geocoder

## Quick Start

### Basic Client Usage

```typescript
import { GeoPlacesClient, SuggestCommand } from '@chaosity/location-client'

const client = new GeoPlacesClient({
  apiUrl: 'https://api.example.com',
  token: 'your-bearer-token'
})

const command = new SuggestCommand({
  QueryText: 'Vancouver',
  MaxResults: 5
})

const response = await client.send(command)
```

### Server-Side Authentication (Next.js Server Action)

```typescript
// app/actions/location.ts
'use server'

export async function getLocationConfig() {
  const response = await fetch('https://api.example.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.LOCATION_CLIENT_ID!,
      client_secret: process.env.LOCATION_CLIENT_SECRET!,
      grant_type: 'client_credentials'
    })
  })
  
  const data = await response.json()
  return {
    apiUrl: 'https://api.example.com',
    token: data.access_token
  }
}
```

### MapLibre Integration

```typescript
import { GeoPlaces } from '@chaosity/location-client'
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder'
import maplibregl from 'maplibre-gl'

const map = new maplibregl.Map({ /* ... */ })
const geoPlaces = new GeoPlaces(apiUrl, token, map)

// Add geocoder control
const geocoder = new MaplibreGeocoder(geoPlaces, {
  maplibregl,
  showResultsWhileTyping: true,
  limit: 30
})

map.addControl(geocoder, 'top-left')

// Handle result selection
geocoder.on('result', async (event) => {
  const { id, result_type } = event.result
  if (result_type === 'Place') {
    const details = await geoPlaces.searchByPlaceId(id)
    console.log('Place details:', details)
  }
})
```

## API Reference

### GeoPlacesClient

Main client for executing commands.

```typescript
const client = new GeoPlacesClient({
  apiUrl: string,
  token: string
})

await client.send(command)
```

### GeoPlaces Adapter

MapLibre Geocoder adapter for search and geocoding.

```typescript
const geoPlaces = new GeoPlaces(apiUrl, token, map)

// Forward geocoding (search)
await geoPlaces.forwardGeocode({ query: 'Vancouver' })

// Reverse geocoding (coordinates to address)
await geoPlaces.reverseGeocode({ query: [-123.12, 49.28] })

// Get place details by ID
await geoPlaces.searchByPlaceId('place-id')
```

### Available Commands

All AWS Location Service commands from `@aws-sdk/client-geo-places`:

```typescript
import {
  SuggestCommand,
  GeocodeCommand,
  ReverseGeocodeCommand,
  GetPlaceCommand,
  SearchTextCommand,
  SearchNearbyCommand
} from '@chaosity/location-client'
```

### Data Type Utilities

GeoJSON conversion utilities from `@aws/amazon-location-utilities-datatypes`:

```typescript
import {
  placeToFeatureCollection,
  routeToFeatureCollection,
  devicePositionsToFeatureCollection
} from '@chaosity/location-client'
```

## Logging

The library uses the `debug` package for optional verbose logging. Enable it via the `DEBUG` environment variable:

```bash
# Enable all location-client logs
DEBUG=location-client:* npm run dev

# Enable only authentication logs
DEBUG=location-client:auth npm run dev

# Enable only API request logs
DEBUG=location-client:api npm run dev

# Enable multiple namespaces
DEBUG=location-client:*,express:* npm run dev
```

Example output:
```
location-client:auth Initializing TokenProvider for https://api.example.com +0ms
location-client:auth Fetching new token from https://api.example.com +2ms
location-client:auth Token acquired successfully (expires in 3600s) +145ms
location-client:api Sending SuggestCommand request to /address/suggestion +0ms
location-client:api Request successful: 200 (89ms) +89ms
```

## Security Best Practices

⚠️ **NEVER expose client credentials in browser code!**

- Store `client_id` and `client_secret` in server environment variables
- Use Server Actions or API routes to fetch tokens
- Only send the JWT token to the browser
- Tokens should be short-lived and refreshed as needed

## Example: Complete MapLibre Setup

```typescript
'use client'

import { GeoPlaces } from '@chaosity/location-client'
import { getLocationConfig } from '@/lib/actions/location'
import maplibregl from 'maplibre-gl'
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder'

export default function MapComponent() {
  useEffect(() => {
    async function initMap() {
      // Get config from server
      const { apiUrl, token } = await getLocationConfig()
      
      // Initialize map
      const map = new maplibregl.Map({
        container: 'map',
        style: `${apiUrl}/maps/Standard/descriptor`,
        center: [-123.12, 49.28],
        zoom: 10,
        transformRequest: (url) => {
          if (url.startsWith(apiUrl)) {
            return {
              url,
              headers: { 'Authorization': `Bearer ${token}` }
            }
          }
          return { url }
        }
      })
      
      // Add geocoder
      const geoPlaces = new GeoPlaces(apiUrl, token, map)
      const geocoder = new MaplibreGeocoder(geoPlaces, { maplibregl })
      map.addControl(geocoder, 'top-left')
    }
    
    initMap()
  }, [])
  
  return <div id="map" style={{ width: '100%', height: '600px' }} />
}
```

## TypeScript Support

Full TypeScript support with types from AWS SDK:

```typescript
import type { SuggestCommandOutput } from '@aws-sdk/client-geo-places'

const response: SuggestCommandOutput = await client.send(
  new SuggestCommand({ QueryText: 'Vancouver' })
)
```

## License

MIT
