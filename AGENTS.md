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
npm run build       # tsc (ESM) + tsc -p tsconfig.cjs.json (CJS) + the CJS marker
npm run dev         # tsc --watch
npm test            # vitest run — 192 tests across 10 files
npm run test:watch  # vitest interactive
npm run smoke       # loads dist/ as ESM and as CJS — run it after build
npm run lint        # eslint . AND prettier --check .
npm run lint:fix    # eslint --fix . && prettier --write .
```

`npm run lint` runs Prettier as well as ESLint, so a formatting-only problem
fails the lint step — run `lint:fix`, not just `eslint --fix`.

### The push gate

`.husky/pre-push` runs `npm ci --dry-run` (lockfile drift), `npm run lint`,
`npm test`, **`npm run build`**, then **`npm run smoke`** — so a push needs a
clean compile and a package that actually loads, not just green tests. Type
errors that vitest tolerates are stopped by the build; a package that compiles
but cannot be `import`ed is stopped by the smoke step (see Conventions).

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

- **Relative imports in `src/` must carry a `.js` extension**, even though the
  source is `.ts`: `import { x } from './transport/http.js'`. This applies to
  `src/` — what `tsc` compiles and emits. Files in `test/` are outside
  `tsconfig.json`'s `include`, are never emitted, and are resolved by vitest, so
  they stay extensionless; leave them alone. `tsconfig.json` is
  `moduleResolution: NodeNext`, which is what Node's own ESM resolver requires —
  and TypeScript maps the `.js` specifier back to the `.ts` file for you. This is
  the single easiest thing to get wrong here, and it used to be wrong everywhere:
  the package emitted extensionless specifiers, so every `import` outside a
  bundler died with `ERR_MODULE_NOT_FOUND` (#35). `0.5.1` is published in that
  state.
- **Dual ESM/CJS** (`"type": "module"`). `npm run build` runs `tsc` twice: ESM
  into `dist/`, CommonJS into `dist/cjs/`, and `scripts/finish-cjs.mjs` writes a
  `{"type":"commonjs"}` package.json beside the second so Node reads it as CJS.
  The `exports` map routes `import` and `require` accordingly. Adding an entry
  point means adding **both** conditions.
- **One process should load one half, not both.** That is the standing cost of a
  dual package: `require` and `import` get separate module registries, so a
  consumer mixing them holds two `LocationServiceException` classes — and
  `instanceof` fails across that line, on the one error type callers are told to
  catch — plus two copies of `getClientConfig`'s module-level token cache. Pick a
  module system per process and stay in it.
- **`npm run smoke` is the test that a build cannot replace.** It resolves
  `dist/` through Node itself as ESM and as CJS, checks both entry points expose
  what they promise, asserts the two module systems expose the _same_ surface,
  and re-checks that nothing server-only leaks into the root. Everything else in
  the gate passed while the package was unloadable.
- The root re-exports both AWS barrels with `export *`, which no bundler can
  tree-shake: a consumer importing only a map helper still pays ~93 KB. Tracked
  in **#42** — prefer fixing it over adding another `export *`.
- `maplibre-gl` and `@maplibre/maplibre-gl-geocoder` are **optional peer
  dependencies**, and both are imported with `import type` only. Map helpers must
  not make them a hard requirement for consumers who only use the Places
  commands — a consumer who never touches the map surface should not download
  them at all.
- Tests are vitest and live in `test/`, not beside the source. New behaviour
  needs one; the suite is the only thing standing between a refactor and a
  silent break in a published package.
- Prettier runs with `prettier-plugin-organize-imports`, so import order is
  managed for you — do not hand-sort.
