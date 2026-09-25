import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as Root from '../src/index'
import { GeoPlacesClient, VerifyAddressCommand } from '../src/index'
import { LocationServiceConnector } from '../src/server/LocationServiceConnector'
import { resolveEndpoint } from '../src/transport/endpoints'
import { typeErrors } from './typecheck'

/**
 * `POST /address/verify` (#54).
 *
 * The service resolves one PlaceId to the full place record plus `verified`,
 * and that answer is the one Places result an integrator may store. The route
 * has no AWS SDK command, so nothing in `ENDPOINTS` mapped to it and neither
 * send path could reach it. It is a command of this package's own, so both
 * transports, the 401 self-heal, the retry budget and the body guard in
 * `bias-precision.test.ts` cover it without a second code path.
 */

const API = 'https://api.test'
const PLACE_ID = 'AQAAAGEAexample-place-id'
const UNIT_PLACE_ID = 'AQAAAHQAexample-unit-place-id'

/** What the service answers for a locality: a 200, and not a verified address. */
const LOCALITY = {
  PlaceId: PLACE_ID,
  PlaceType: 'Locality',
  Title: 'Sydney, NSW, Australia',
  Address: { Label: 'Sydney, NSW, Australia', Locality: 'Sydney' },
  Position: [151.21, -33.87],
  PricingBucket: 'Stored',
  verified: false,
}

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>

const call = (n = 0) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit]
  return { url, init }
}

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async () => answer(LOCALITY))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('VerifyAddressCommand', () => {
  it('resolves to /address/verify', () => {
    expect(
      resolveEndpoint(new VerifyAddressCommand({ PlaceId: PLACE_ID })),
    ).toBe('/address/verify')
  })

  it('carries the input unchanged', () => {
    expect(new VerifyAddressCommand({ PlaceId: PLACE_ID }).input).toEqual({
      PlaceId: PLACE_ID,
    })
  })
})

describe('every command the root exports resolves to a route', () => {
  // A command added without an ENDPOINTS entry used to compile, export and
  // then throw UnknownCommandException at the first caller. Read from the
  // root, not listed here, so the next one fails in this file instead. The
  // SDK's `$Command` base class rides in on the `export *`; it is not a
  // command anyone sends, and the pattern is places-commands.test.ts's.
  const commands = Object.entries(Root).filter(
    ([name, value]) =>
      /^[A-Z]\w*Command$/.test(name) && typeof value === 'function',
  ) as [string, new (input: object) => { input: object }][]

  it('found the commands', () => {
    expect(commands.map(([name]) => name)).toContain('VerifyAddressCommand')
    expect(commands.map(([name]) => name)).toContain('SearchTextCommand')
  })

  it.each(commands)('%s', (_name, Command) => {
    expect(() => resolveEndpoint(new Command({}))).not.toThrow()
  })
})

describe.each([
  [
    'GeoPlacesClient',
    () => new GeoPlacesClient({ apiUrl: API, token: 'token' }),
  ],
  [
    'LocationServiceConnector',
    () =>
      new LocationServiceConnector({
        apiUrl: API,
        token: 'token',
        origin: 'https://app.example.com',
      }),
  ],
])('%s', (_name, make) => {
  it('sends the command to /address/verify with exactly {"PlaceId"}', async () => {
    await make().send(new VerifyAddressCommand({ PlaceId: PLACE_ID }))

    const { url, init } = call()
    expect(url).toBe(`${API}/address/verify`)
    expect(init.method).toBe('POST')
    // The raw string: the service narrows this route to PlaceId alone, so
    // anything else in the body would be dropped rather than honoured.
    expect(init.body).toBe(JSON.stringify({ PlaceId: PLACE_ID }))
  })

  it('verifyAddress(placeId) is the same request', async () => {
    await make().verifyAddress(UNIT_PLACE_ID)

    const { url, init } = call()
    expect(url).toBe(`${API}/address/verify`)
    expect(init.body).toBe(JSON.stringify({ PlaceId: UNIT_PLACE_ID }))
  })

  it('resolves a 200 with verified: false — a "no" is an answer', async () => {
    const result = await make().verifyAddress(PLACE_ID)

    expect(result).toEqual(LOCALITY)
    expect(result.verified).toBe(false)
  })

  it('passes the transport options through', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      make().verifyAddress(PLACE_ID, {
        signal: controller.signal,
        retry: false,
      }),
    ).rejects.toMatchObject({ code: 'AbortedException' })
  })
})

describe('the types say what the service does', () => {
  it('compiles with exactly the expected errors', () => {
    const source = [
      `import * as C from '../src/index.js'`,
      `import { LocationServiceConnector } from '../src/server/index.js'`,
      `declare const client: C.GeoPlacesClient`,
      `declare const connector: LocationServiceConnector`,
      ``,
      `// The input is PlaceId and nothing else: the service forwards nothing else.`,
      `new C.VerifyAddressCommand({ PlaceId: 'p' })`,
      `const input: C.VerifyAddressCommandInput = { PlaceId: 'p' }`,
      `// @ts-expect-error PlaceId is required`,
      `new C.VerifyAddressCommand({})`,
      `// @ts-expect-error Language is dropped by the service`,
      `new C.VerifyAddressCommand({ PlaceId: 'p', Language: 'en' })`,
      `// @ts-expect-error IntendedUse is never forwarded`,
      `new C.VerifyAddressCommand({ PlaceId: 'p', IntendedUse: 'Storage' })`,
      `// @ts-expect-error AdditionalFeatures is dropped by the service`,
      `new C.VerifyAddressCommand({ PlaceId: 'p', AdditionalFeatures: ['Contact'] })`,
      ``,
      `// The answer is the GetPlace record plus verified, on both clients.`,
      `async function read() {`,
      `  const a: C.VerifyAddressResponse = await client.verifyAddress('p')`,
      `  const b: C.VerifyAddressResponse = await connector.verifyAddress('p', { headers: { Origin: 'o' } })`,
      `  const verified: boolean = a.verified`,
      `  const type: string | undefined = b.PlaceType`,
      `  const units: C.RelatedPlace[] | undefined = a.SecondaryAddresses`,
      `  // @ts-expect-error the service strips $metadata`,
      `  a.$metadata`,
      `  return [input, verified, type, units]`,
      `}`,
      `void read`,
      '',
    ].join('\n')

    expect(typeErrors('__verify-address__.ts', source)).toEqual([])
  }, 60_000)
})
