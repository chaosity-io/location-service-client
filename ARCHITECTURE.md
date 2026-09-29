# Client Library Architecture

## Design Philosophy

**Reuse the AWS SDK's commands and types; replace the auth and the transport**

This client and Amazon's differ in how a request is authenticated and where
it goes:

- AWS SDK: SigV4 (IAM credentials), straight to Amazon Location
- This client: a Bearer token (OAuth 2.0 client credentials), to this service's
  API, which calls Amazon Location for you

The request and response types are the AWS SDK's, with two differences:

- The seven Places commands take neither `IntendedUse` nor `Key`. The service
  strips both from every request, so the commands this package exports are
  typed without them (`NeverForwarded` in `src/client/commands.ts`, #40).
- The API forwards a fixed set of request fields on each route. A field a
  newer SDK adds type-checks at once, but reaches Amazon Location only once the
  API forwards it.

## Architecture Layers

### 1. Auth Layer (server-only: `@chaosity/location-client/server`)

- `TokenProvider` - asks `/auth/token` for a token with the client
  credentials, caches it until shortly before its `exp`, shares one request
  between concurrent callers, and remembers a refusal (#38)
- `getClientConfig()` - reads the credentials from the environment and
  returns `{ apiUrl, token, expiresAt }` as plain data, for a Server Action to
  hand to the browser
- `LocationServiceConnector` - the server-side client: completes its
  configuration from the environment, holds a live token source, and sends the
  `Origin` the API requires

Each takes the client secret, so none of them is exported from the root.

### 2. Client Layer (custom wrapper, AWS SDK commands)

- `GeoPlacesClient` - the browser-safe client: sends a command with a Bearer
  token from `token`, `getToken` or `refreshToken`
- Uses the AWS SDK's command classes, narrowed (#40), plus one of the
  package's own for a route the SDK has no command for (`VerifyAddressCommand`,
  #54)
- Both clients send through one transport (`src/transport/http.ts`): timeouts,
  retries, cancellation, and one error type, `LocationServiceException`

### 3. Adapter Layer (Custom)

- `GeoPlaces` - the `MaplibreGeocoderApi` for `@maplibre/maplibre-gl-geocoder`:
  converts the Places responses to GeoJSON features the geocoder control
  renders

### 4. Maps

- `fetchMapStyle`, `buildMapStyleUrl`, `createTransformRequest`,
  `fetchStaticMap`, `applyMapLanguage` and the POI toggles, for this service's
  map routes

## What's Custom vs AWS SDK

### Custom (Maintained by us)

```typescript
// Auth (server-only)
TokenProvider
getClientConfig
LocationServiceConnector

// Client wrapper
GeoPlacesClient.send() // Replaces SigV4 with Bearer token

// Adapter
GeoPlaces // Converts to MapLibre format

// The one route with no SDK command
VerifyAddressCommand
```

### From AWS Packages (re-exported)

```typescript
// Commands and types: @aws-sdk/client-geo-places. The seven Places commands
// are this package's narrowed subclasses of the SDK's.
import {
  AutocompleteCommand,
  GeocodeCommand,
  GetPlaceCommand,
  type SuggestCommandOutput,
} from '@chaosity/location-client'

// GeoJSON converters: @aws/amazon-location-utilities-datatypes. These take a
// Places response; the README lists which.
import {
  geocodeResponseToFeatureCollection,
  suggestResponseToFeatureCollection,
} from '@chaosity/location-client'
```

## Benefits

1. **Little Type Maintenance** - Request and response types come from the AWS
   SDK; only the seven narrowed Places inputs are this package's
2. **Little Command Maintenance** - The SDK's commands track the AWS SDK; the
   one command the SDK lacks (`VerifyAddressCommand`) is this package's own
3. **AWS SDK Updates** - A new SDK field type-checks at once; it reaches
   Amazon Location once the API forwards it
4. **Type Safety** - Full TypeScript support from AWS SDK
5. **Documentation** - Refer to AWS SDK docs for the fields, and to this
   service's API reference for which it forwards

## Usage Pattern

```typescript
// 1. Import AWS Location Client commands
import { GeoPlacesClient, SuggestCommand } from '@chaosity/location-client'

// 2. Create client with Bearer token auth
const client = new GeoPlacesClient({ apiUrl, token })

// 3. Use AWS Location Client commands. Suggest takes exactly one of BiasPosition, Filter.BoundingBox or Filter.Circle.
const command = new SuggestCommand({
  QueryText: 'Vancouver',
  BiasPosition: [-123.1207, 49.2827],
})
const response = await client.send(command)
```

## Comparison with AWS SDK

### AWS Location Client

```typescript
import { GeoPlacesClient, places } from '@aws/amazon-location-client'
import { withAPIKey } from '@aws/amazon-location-client'

const authHelper = withAPIKey('api-key', 'us-east-1')
const client = new GeoPlacesClient(authHelper.getClientConfig())

const command = new places.SuggestCommand({
  QueryText: 'Vancouver',
  BiasPosition: [-123.1207, 49.2827],
})
const response = await client.send(command)
```

### Our Client

```typescript
import { GeoPlacesClient, SuggestCommand } from '@chaosity/location-client'

const client = new GeoPlacesClient({
  apiUrl: 'https://api.example.com',
  token: 'bearer-token',
})

const command = new SuggestCommand({
  QueryText: 'Vancouver',
  BiasPosition: [-123.1207, 49.2827],
})
const response = await client.send(command)
```

**Differences**: auth config (Bearer token vs API key/SigV4), and the commands
are named exports rather than a `places` namespace
