import { describe, expect, it } from 'vitest'
import { readAppConfigClaims } from '../src/utils/tokenClaims'

/**
 * What the access token tells this library about the application using it
 * (api#65), and the discipline around it: these claims are for DISPLAY. None
 * of them shapes a request.
 *
 * `biasDecimals` was the exception that proved why the rule is worth keeping.
 * It shaped one — the grid `BiasPosition` was rounded onto — and when the
 * server-side cache it existed to feed went away, the claim stopped being
 * issued while the rounding stayed, so every caller was silently flattened
 * onto the 3 dp default grid (#51).
 */

/** A token whose payload is exactly these claims; signature is never checked. */
const tokenWith = (claims: Record<string, unknown>): string => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.not-a-real-signature`
}

describe('reading app config off the token', () => {
  it('reads countries', () => {
    const token = tokenWith({ countries: ['AU', 'NZ'] })
    expect(readAppConfigClaims(token)).toEqual({ countries: ['AU', 'NZ'] })
  })

  it('returns nothing for a token carrying only protocol claims', () => {
    // Who the token is for and how long it lives are not application
    // settings. `exp` has its own reader, readTokenExpiry.
    const token = tokenWith({
      client_id: 'abc',
      sub: 'app-uuid',
      scope: 'api:access',
      aud: 'the-api',
      iss: 'the-issuer',
      iat: 1,
      exp: 2,
      jti: 'j',
    })
    expect(readAppConfigClaims(token)).toEqual({})
  })

  it('does not surface a biasDecimals claim, even one that is present', () => {
    // No token the API issues carries this any more. One that does — an old
    // token still in flight, a hand-made one — must not bring the claim back
    // into the library's surface, because nothing reads it and a caller
    // finding it there would reasonably assume something does.
    const token = tokenWith({ biasDecimals: 5, countries: ['AU'] })
    expect(readAppConfigClaims(token)).toEqual({ countries: ['AU'] })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['not a JWT', 'hello'],
    ['wrong segment count', 'a.b'],
    ['undecodable payload', 'aaa.!!!not-base64!!!.ccc'],
  ])('degrades to no claims for %s rather than throwing', (_l, token) => {
    // This runs on every request. A surprising token must not break geocoding
    // for an application that is otherwise working.
    expect(() => readAppConfigClaims(token as string)).not.toThrow()
    expect(readAppConfigClaims(token as string)).toEqual({})
  })

  it('ignores claim values of the wrong type', () => {
    const token = tokenWith({ countries: 'AU' })
    expect(readAppConfigClaims(token)).toEqual({})
  })
})

describe('the countries claim is exposed, never acted on', () => {
  it('is readable, so an application can show the markets it serves', () => {
    const token = tokenWith({ countries: ['AU', 'NZ'] })
    expect(readAppConfigClaims(token).countries).toEqual(['AU', 'NZ'])
  })

  it('is surfaced by the browser client', async () => {
    const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
    const client = new GeoPlacesClient({
      apiUrl: 'https://example.invalid',
      token: tokenWith({ countries: ['AU'] }),
    } as never)

    expect(client.getAppConfig()).toEqual({ countries: ['AU'] })
  })

  it('is empty when the application has no config', async () => {
    const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
    const client = new GeoPlacesClient({
      apiUrl: 'https://example.invalid',
      token: tokenWith({ client_id: 'abc' }),
    } as never)

    expect(client.getAppConfig()).toEqual({})
  })

  it('does NOT inject countries into a request', async () => {
    // The reason, measured against the API: if the scope changed in the portal
    // and the token is stale, injecting turns a request that would have
    // SUCCEEDED into a 400.
    //
    //   app now scoped to NZ, token still says AU
    //     send nothing      -> API injects [NZ] -> 200
    //     inject stale [AU] -> outside scope    -> 400
    //
    // The API always has fresh data; the token never does. Sending nothing is
    // strictly better than any client-side guess.
    const sent: Record<string, unknown>[] = []
    const fetchSpy = async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ ResultItems: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as never
    try {
      const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
      const client = new GeoPlacesClient({
        apiUrl: 'https://example.invalid',
        token: tokenWith({ countries: ['AU'] }),
      } as never)
      const { SearchTextCommand } = await import('@aws-sdk/client-geo-places')
      await client.send(new SearchTextCommand({ QueryText: 'cafe' }) as never)
    } finally {
      globalThis.fetch = original
    }

    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty('Filter')
  })
})

describe('allowedResources and allowedDomain are exposed, never acted on (#40)', () => {
  // The API issues `allowedResources` JSON-ENCODED — a string holding a list —
  // because it copies the application's row, which stores it that way. Read
  // off a real token on 24 Sep 2026. A reader that only accepted an array
  // would surface nothing from any token the API actually issues.
  const RESOURCES = [
    'POST /address/autocomplete',
    'GET /maps/static/{fileName}',
  ]

  it('reads allowedResources as the API issues it: a JSON-encoded list', () => {
    const token = tokenWith({ allowedResources: JSON.stringify(RESOURCES) })
    expect(readAppConfigClaims(token)).toEqual({ allowedResources: RESOURCES })
  })

  it('reads allowedResources given as a plain list too', () => {
    const token = tokenWith({ allowedResources: RESOURCES })
    expect(readAppConfigClaims(token)).toEqual({ allowedResources: RESOURCES })
  })

  it('keeps an empty list: an application entitled to nothing says so', () => {
    const token = tokenWith({ allowedResources: '[]' })
    expect(readAppConfigClaims(token)).toEqual({ allowedResources: [] })
  })

  it('reads allowedDomain', () => {
    const token = tokenWith({ allowedDomain: 'app.example.com' })
    expect(readAppConfigClaims(token)).toEqual({
      allowedDomain: 'app.example.com',
    })
  })

  it.each([
    ['a string that is not JSON', { allowedResources: 'POST /x' }],
    ['JSON that is not a list', { allowedResources: '{"a":1}' }],
    ['a number', { allowedResources: 5 }],
    ['an empty domain', { allowedDomain: '' }],
    ['a domain that is not a string', { allowedDomain: 5 }],
  ])('ignores %s', (_l, claims) => {
    expect(readAppConfigClaims(tokenWith(claims))).toEqual({})
  })

  it('drops the non-string entries of a list', () => {
    const token = tokenWith({ allowedResources: JSON.stringify(['GET /a', 1]) })
    expect(readAppConfigClaims(token)).toEqual({ allowedResources: ['GET /a'] })
  })

  it('is surfaced by the browser client, beside countries', async () => {
    const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
    const client = new GeoPlacesClient({
      apiUrl: 'https://example.invalid',
      token: tokenWith({
        countries: ['AU'],
        allowedDomain: 'app.example.com',
        allowedResources: JSON.stringify(RESOURCES),
      }),
    })

    expect(client.getAppConfig()).toEqual({
      countries: ['AU'],
      allowedDomain: 'app.example.com',
      allowedResources: RESOURCES,
    })
  })

  it('does NOT refuse a request for a route the token does not list', async () => {
    // Display only, like countries. The token is up to fifteen minutes old and
    // the API reads the entitlement fresh from the row on every request, so a
    // route granted since the token was minted must still be asked for.
    const sent: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      sent.push(url)
      return new Response(JSON.stringify({ ResultItems: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as never
    try {
      const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
      const client = new GeoPlacesClient({
        apiUrl: 'https://example.invalid',
        token: tokenWith({
          allowedResources: JSON.stringify(['POST /address/autocomplete']),
        }),
      })
      const { SearchTextCommand } = await import('../src/index')
      await client.send(new SearchTextCommand({ QueryText: 'cafe' }))
    } finally {
      globalThis.fetch = original
    }

    expect(sent).toEqual(['https://example.invalid/address/search/text'])
  })
})
