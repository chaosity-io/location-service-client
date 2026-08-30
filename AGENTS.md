# AGENTS.md

Notes for anyone — human or coding agent — working in this repository. It covers
the things that are expensive to rediscover; `README.md` covers usage and
`ARCHITECTURE.md` the design.

`@chaosity/location-client` is a TypeScript client for the Chaosity Location
Service, shaped to be AWS-Location-compatible: it re-exports the
`@aws-sdk/client-geo-places` commands and types so existing AWS code keeps
working, and swaps SigV4 for this service's own bearer-token auth.

## Commands

```bash
npm run build       # tsc
npm run dev         # tsc --watch
npm test            # vitest run — 192 tests across 10 files
npm run test:watch  # vitest interactive
npm run lint        # eslint . AND prettier --check .
npm run lint:fix    # eslint --fix . && prettier --write .
```

`npm run lint` runs Prettier as well as ESLint, so a formatting-only problem
fails the lint step — run `lint:fix`, not just `eslint --fix`.

### The push gate

`.husky/pre-push` runs `npm ci --dry-run` (lockfile drift), `npm run lint`,
`npm test`, then **`npm run build`** — so a push needs a clean compile, not just
green tests. Type errors that vitest tolerates are stopped here.

## The one boundary that matters: `.` vs `./server`

Two entry points, and mixing them is the mistake worth preventing:

```ts
// Browser-safe. Commands, types, map helpers, errors.
import { SearchTextCommand, GeoPlacesClient } from '@chaosity/location-client'

// Server-only. Requires clientId + clientSecret.
import {
  LocationServiceConnector,
  getClientConfig,
  TokenProvider,
} from '@chaosity/location-client/server'
```

`LocationServiceConnector`, `getClientConfig` and `TokenProvider` are the whole
server surface. They take client credentials, so importing any of them into a
browser bundle ships your secret to every visitor. Nothing under `./server` is
re-exported from the root, and it must stay that way.

The root does export `TOKEN_REFRESH_BUFFER_SECONDS` and `readTokenExpiry` from
`auth/tokenRefresh` — that is deliberate and safe. They are refresh-timing
policy shared with the React provider, and carry no credentials.

## The API requires an `Origin` header

Every data request needs an `Origin` the service recognises, and it answers
**403 without one** — server-side calls included, not just browsers. This is the
single most common "why does my request fail" report.

In a browser the browser sets it. Server-side you must, which is what
`ConnectorConfig.origin` is for:

```ts
const connector = new LocationServiceConnector({
  apiUrl,
  origin: 'https://your-allowed-domain.example',
  getToken,
})
```

A per-call `Origin` in `send(...)` headers still overrides the connector default.

`/auth/token` is the exception — it is the one endpoint that does not require an
Origin.

## Versioning: the caret trap on `0.x`

This package is pre-1.0, and **`^0.5.1` will never resolve `0.6.0`**. npm treats
each `0.x` minor as incompatible, which is the only protection consumers get
while the API is still moving.

So on `0.x`, **a breaking change goes in the MINOR, not the major**: a removed or
renamed export, a changed type, behaviour that used to resolve and now rejects.
Patch is for fixes that cannot break a caller.

This also means a dependent package pinned to `^0.5.x` cannot see `0.6.0` until
its own range is bumped — so a base-package minor and its dependents' range
bumps have to be sequenced deliberately.

`RELEASING.md` has the procedure. Releases go out through CI: `build.yml` must
succeed, which triggers `publish.yml` via `workflow_run`, which publishes with
npm provenance. Merging is what publishes — there is no manual `npm publish`
step, and `prepublishOnly` runs the build.

## Treat `ARCHITECTURE.md` and `README.md` with suspicion

Both carry known inaccuracies, tracked in **#8**: `ARCHITECTURE.md` documents
`AuthHelper` / `AuthClient` classes that do not exist and names a package this
library does not depend on; the README's command list omits `AutocompleteCommand`
and advertises routing and tracking utilities this API does not proxy.

Verify against `src/` before relying on either, and prefer fixing them over
working around them.

## Conventions

- **ESM only** (`"type": "module"`), output to `dist/` by `tsc`. There is no CJS
  build, and **#35 reports the ESM entry point itself failing with
  `ERR_MODULE_NOT_FOUND`**, plus missing `sideEffects` and `engines`. Check that
  issue before trusting the published package layout or adding to it.
- `maplibre-gl` is an **optional peer dependency**. Map helpers must not make it
  a hard requirement for consumers who only use the Places commands.
- Tests are vitest and live in `test/`, not beside the source. New behaviour
  needs one; the suite is the only thing standing between a refactor and a
  silent break in a published package.
- Prettier runs with `prettier-plugin-organize-imports`, so import order is
  managed for you — do not hand-sort.
