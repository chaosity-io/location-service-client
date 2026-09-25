# Client Library Architecture

## Design Philosophy

**Reuse AWS SDK, Override Auth Only**

The only difference between this client and AWS SDK is the authentication method:

- AWS SDK: SigV4 (IAM credentials)
- This client: Bearer token (OAuth2)

Everything else is identical to AWS SDK.

## Architecture Layers

### 1. Auth Layer (Custom)

- `AuthHelper` - Token management and refresh
- `AuthClient` - OAuth2 client credentials flow

### 2. Client Layer (Custom wrapper, AWS SDK commands)

- `GeoPlacesClient` - Wraps AWS SDK commands with Bearer auth
- Uses the AWS SDK's command classes, narrowed (#40), plus one of the
  package's own for a route the SDK has no command for (`VerifyAddressCommand`,
  #54)

### 3. Adapter Layer (Custom)

- `GeoPlaces` - Converts AWS SDK responses to MapLibre GeoJSON format

## What's Custom vs AWS SDK

### Custom (Maintained by us)

```typescript
// Auth
AuthHelper
AuthClient

// Client wrapper
GeoPlacesClient.send() // Replaces SigV4 with Bearer token

// Adapter
GeoPlaces // Converts to MapLibre format
```

### From AWS Location Libraries (Zero maintenance)

```typescript
// Commands from AWS Location Client
import { places, maps, routes } from '@aws/amazon-location-client'

const {
  AutocompleteCommand,
  GeocodeCommand,
  GetPlaceCommand,
  // ... all commands
} = places

// Data type utilities
import {
  placeToFeatureCollection,
  routeToFeatureCollection,
  devicePositionsToFeatureCollection,
  // ... all utilities
} from '@aws/amazon-location-utilities-datatypes'
```

## Benefits

1. **Zero Type Maintenance** - Types always in sync with AWS SDK
2. **Little Command Maintenance** - The SDK's commands track the AWS SDK; the
   one command the SDK lacks (`VerifyAddressCommand`) is this package's own
3. **AWS SDK Updates** - New parameters automatically available
4. **Type Safety** - Full TypeScript support from AWS SDK
5. **Documentation** - Refer to AWS SDK docs directly

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
