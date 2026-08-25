import { describe, expect, it } from 'vitest'
import {
  clampBiasDecimals,
  DEFAULT_BIAS_DECIMALS,
  roundPositionFields,
} from '../src/utils/roundPosition'
import { readAppConfigClaims } from '../src/utils/tokenClaims'

/**
 * The two things this library was silently costing people (#3 / T19).
 *
 * It asked Amazon Location for data it then threw away — putting every
 * keystroke in a dearer pricing bucket — and it flattened the bias position
 * onto a 1.1 km grid before sending, which does not return coarser results but
 * different, wrong ones.
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

const SYDNEY = { QueryText: 'cafe', BiasPosition: [151.20931, -33.86882] }

describe('bias precision defaults to the correct value, not the cheapest', () => {
  it('rounds to 3 dp by default, not the 2 dp this library used to send', () => {
    // 2 dp is ~1.1 km. Measured against Amazon Location, the same "cafe" query
    // biased 111 m apart returns a completely different set of places — so the
    // old default did not return coarser results, it returned wrong ones.
    expect(DEFAULT_BIAS_DECIMALS).toBe(3)
    const out = roundPositionFields(SYDNEY)
    expect(out.BiasPosition).toEqual([151.209, -33.869])
  })

  it('never rounds QueryPosition, whatever the precision', () => {
    // Reverse-geocode resolves an exact point a user clicked. Rounding it
    // returns a neighbour's address (RFC-0001 §2).
    const input = { QueryPosition: [151.20931, -33.86882] }
    for (const dp of [3, 4, 5]) {
      expect(roundPositionFields(input, dp).QueryPosition).toEqual([
        151.20931, -33.86882,
      ])
    }
  })

  it('honours a finer entitlement', () => {
    expect(roundPositionFields(SYDNEY, 5).BiasPosition).toEqual([
      151.20931, -33.86882,
    ])
  })

  it('does not mutate the caller input', () => {
    const original = { BiasPosition: [151.20931, -33.86882] }
    roundPositionFields(original, 3)
    expect(original.BiasPosition).toEqual([151.20931, -33.86882])
  })

  it('leaves inputs with no position field untouched', () => {
    const input = { QueryText: 'cafe' }
    expect(roundPositionFields(input)).toBe(input)
  })
})

describe('the precision band mirrors the server (api#65)', () => {
  it.each([[2], [1], [0], [-3]])('clamps %i dp up to the 3 dp floor', (dp) => {
    expect(clampBiasDecimals(dp)).toBe(3)
  })

  it('caps at 5 dp', () => {
    // Finer precision collapses the cache hit rate, and every miss is a
    // billable upstream call.
    expect(clampBiasDecimals(8)).toBe(5)
    expect(clampBiasDecimals(99)).toBe(5)
  })

  it('allows the band between', () => {
    expect(clampBiasDecimals(3)).toBe(3)
    expect(clampBiasDecimals(4)).toBe(4)
    expect(clampBiasDecimals(5)).toBe(5)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['nonsense', 'wide'],
    ['an object', {}],
    ['an array', []],
    ['NaN', NaN],
  ])('falls back to the default for %s', (_label, value) => {
    // `Number(null)`, `Number('')` and `Number([])` are all 0 — finite, and so
    // accepted by the obvious check. That would silently mean "precision 0".
    expect(clampBiasDecimals(value)).toBe(DEFAULT_BIAS_DECIMALS)
  })

  it('accepts a numeric string', () => {
    expect(clampBiasDecimals('4')).toBe(4)
  })
})

describe('reading app config off the token', () => {
  it('reads biasDecimals and countries', () => {
    const token = tokenWith({ biasDecimals: 5, countries: ['AU', 'NZ'] })
    expect(readAppConfigClaims(token)).toEqual({
      biasDecimals: 5,
      countries: ['AU', 'NZ'],
    })
  })

  it('returns nothing for a token carrying no app config', () => {
    // The API omits these claims entirely when the application has none
    // configured, which is every application today.
    const token = tokenWith({ client_id: 'abc', allowedDomain: 'example.com' })
    expect(readAppConfigClaims(token)).toEqual({})
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
    const token = tokenWith({ biasDecimals: {}, countries: 'AU' })
    expect(readAppConfigClaims(token)).toEqual({})
  })

  it('feeds straight into rounding, so an entitled app gets its precision', () => {
    const { biasDecimals } = readAppConfigClaims(tokenWith({ biasDecimals: 5 }))
    expect(roundPositionFields(SYDNEY, biasDecimals).BiasPosition).toEqual([
      151.20931, -33.86882,
    ])
  })

  it('an unentitled app lands on the floor, not the old 2 dp', () => {
    const { biasDecimals } = readAppConfigClaims(tokenWith({ client_id: 'x' }))
    expect(roundPositionFields(SYDNEY, biasDecimals).BiasPosition).toEqual([
      151.209, -33.869,
    ])
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
      token: tokenWith({ countries: ['AU'], biasDecimals: 4 }),
    } as never)

    expect(client.getAppConfig()).toEqual({
      countries: ['AU'],
      biasDecimals: 4,
    })
  })

  it('is empty when the application has no config, which is every app today', async () => {
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
