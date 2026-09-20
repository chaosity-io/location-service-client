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

  it('returns nothing for a token carrying no app config', () => {
    // The API omits these claims entirely when the application has none
    // configured, which is every application without a country scope.
    const token = tokenWith({ client_id: 'abc', allowedDomain: 'example.com' })
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
