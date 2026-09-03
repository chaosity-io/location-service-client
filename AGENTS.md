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
npm test            # vitest run
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

In a browser the browser sets it. Server-side you must: `ConnectorConfig.origin`,
`LOCATION_ORIGIN` in the environment, or a per-call `Origin` in `send(...)`
headers, which overrides both.

**Exactly one of each system header must leave, whatever the caller
capitalised.** `fetch` builds its `Headers` by APPENDING, not replacing, so a
record carrying both `Origin` and `origin` goes out as `Origin: a, b`. Spreading
the system headers last is NOT enough — it only out-ranks a caller key spelled
identically. The consequences differ by header and both are real:

- `Origin: default, per-call` — the API matches the allowed domain exactly, so
  it 403s. Two keys with the same value fare no better (`Origin: x, x`).
- `Authorization: Bearer not-yours, Bearer <real>` — worse than a failed
  override: a caller's lowercase `authorization` **corrupts** the token rather
  than being ignored by it.

So `dispatch` drops the caller's spelling of every header it sets — the list is
`SYSTEM_HEADERS`, kept beside `withoutHeaders`, and it must gain any header the
record gains. Origin's value comes from `effectiveOrigin`, which the 403
explanation also reads, so the merge and the explanation cannot disagree about
whether an Origin was sent; removing the duplicate never overrides the caller's
intent.

`LocationServiceConnector` is the only place in the package that merges
caller-supplied headers at all — `GeoPlacesClient`'s `SendOptions` is
`RequestOptions`, with no `headers` — so if you add a second such site, this is
the trap.

`/auth/token` is the exception — it is the one endpoint that does not require an
Origin.

## `LocationServiceConnector` completes its config; it does not replace it

The constructor used to be all-or-nothing —
`config ? Promise.resolve(config) : getClientConfig()` — and the consequence was
that **neither documented form could make a successful data call** (#45). The
zero-argument form read credentials from the environment but had no `origin`, so
every data request 403'd; `{ origin }`, the obvious repair, took the other branch
and had no credentials at all.

So: an explicit `token` or `getToken` wins outright — a caller managing its own
credentials must never have another application's substituted underneath it —
and **anything short of that is filled in from the environment** (`LOCATION_API_URL`,
`LOCATION_CLIENT_ID`, `LOCATION_CLIENT_SECRET`, `LOCATION_ORIGIN`, and the
`LOCATION_SERVICE_*` spellings). Keep that shape when adding a field.

The two ways of supplying a token are not equivalent, and the difference is not
cosmetic: `token` is a fixed string that dies at its own `exp`, while `getToken`
and the environment path are LIVE — asked on every request, and asked again with
`forceRefresh: true` when the API answers 401. Prefer live sources in docs and
samples.

## `getClientConfig` must keep returning plain data

`{ apiUrl, token, expiresAt }` — no methods, no closures, and this is load-bearing.
Every Next.js sample returns it straight out of a `'use server'` action to a
Client Component, and the RSC boundary serialises the result: a function on the
object throws there. #36 proposed adding `getToken` to it; that would have broken
every one of them.

A caller needing a token that refreshes wants `LocationServiceConnector` (which
holds `serverTokenSource` internally) or `TokenProvider` directly.
`test/get-client-config.test.ts` asserts the shape so the mistake cannot be made
quietly.

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
- **Whether a URL gets the bearer token is a URL comparison, never a string
  prefix.** `url.startsWith(apiUrl)` matched `https://api.example.com.evil.test`
  against `https://api.example.com` and handed the customer's token to it (#34);
  a style descriptor is data, so its sprite/glyphs/source URLs are the style
  author's choice. `createTransformRequest` compares `origin` and requires the
  path prefix at a `/` boundary, and fails closed on anything unparseable.
- **Every outbound request goes through `transport/http.ts`.** There is exactly
  one `fetch(` call in `src/`, inside `request()`, and that is the invariant:
  timeout, overall budget, cancellation, retry and the single error type all
  live there, so anything bypassing it silently opts out of all five. The two
  map fetches did, and a network fault there escaped as a raw `TypeError` while
  the identical fault anywhere else arrived as `NetworkException` (#37). Read
  the body INSIDE the loop — `requestJson` and `requestBlob` pass a reader in
  for exactly that reason — or a malformed body stops being a retryable attempt
  and becomes a raw `SyntaxError`.
- **`timeoutMs` bounds an attempt; `overallTimeoutMs` bounds the call.** The
  gap between those two is where a caller's deadline used to disappear: the API
  answers a spent quota with `Retry-After: 60`, honoured literally twice, so a
  30-second caller waited two minutes. A wait that would outlast the remaining
  budget is not taken at all — the API's own error is thrown instead, with
  `retryAfterMs` on it, which is more useful to the caller than a timeout. The
  30 s default sits just under the old worst case (three default attempts that
  all time out came to ~30.75 s), so the overlap is a ~0.75 s window in a third
  attempt whose two predecessors both timed out — small, but not empty, which is
  why it went out in a minor.
- **Nothing sends `Bearer undefined`.** Five places in `src/` interpolate a
  token into an `Authorization` header, and every one of them checks first:
  `GeoPlacesClient` (which asks `refreshToken` before refusing, since the 401
  self-heal cannot cover a request that was never accepted),
  `LocationServiceConnector`, `fetchMapStyle`, `fetchStaticMap`, and
  `createTransformRequest` — which warns and omits the header rather than
  throwing, because MapLibre calls it synchronously and cannot handle a throw.
  The shared factory is `noTokenAvailable` in `transport/errors.ts`; only the
  advice differs per path. A sixth site must join the list, not the exceptions.
- **The server token cache is a bounded LRU, not a slot.** `getClientConfig`
  held ONE `TokenProvider` in two module variables, so a process serving two
  applications evicted on every alternation — a full `/auth/token` round trip
  per call, a jti row each, against the one shared token-endpoint throttle, at a
  0% hit rate (#39). It is now `Map<configKey, TokenProvider>` capped at
  `MAX_CACHED_PROVIDERS`, re-inserted on a hit so insertion order IS the recency
  order. The key still hashes the client secret (#5) — do not simplify it.
- **A 401 is retried once; a 403 never is.** Both send paths refresh and retry
  on 401 only, and only when the replacement is genuinely a different token —
  the API's 403s (Origin not allowed, no domain configured) cannot be fixed by a
  new token, and re-sending a doomed request sends it twice. `isTokenRejected`
  in `transport/errors.ts` is the single place that decides.
- **An error response is not billed, whatever its status.** The service meters
  successful requests, so a 401, a 403 or a 400 costs the caller a round trip and
  its own deadline — not money. Worth checking before writing "and it is billed"
  into a comment about a failure path: this file has now had that sentence wrong
  twice, first claiming a 401 was billed and then a 403.
- Tests are vitest and live in `test/`, not beside the source. New behaviour
  needs one; the suite is the only thing standing between a refactor and a
  silent break in a published package.
- Prettier runs with `prettier-plugin-organize-imports`, so import order is
  managed for you — do not hand-sort.
