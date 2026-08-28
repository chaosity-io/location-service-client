import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildStaticMapUrl,
  fetchStaticMap,
  staticMapAccept,
} from '../src/maps/staticMap'

/**
 * The rule this file exists for: Accept must name the exact type, and the type
 * follows the STYLE, not the file name.
 *
 * Measured against the sandbox on 2026-08-26 —
 *
 *   style=Standard   + Accept: image/png   -> 200, magic 89504e47 (PNG)
 *   style=Satellite  + Accept: image/jpeg  -> 200, magic ffd8ffe0 (JPEG)
 *   style=Satellite  + Accept: image/png   -> 406
 *   any style        + Accept: image/*     -> 406
 *   any style        + Accept: (wildcard)  -> 406
 *
 * Not even `image/*` is accepted. And Satellite is the DEFAULT, so the naive
 * `Accept: image/png` is wrong for a request that omits `style` entirely —
 * which is precisely the mistake the API made in the other direction, labelling
 * every default JPEG render as a PNG.
 */

const API = 'https://api.example.test'
const token = () => 'tok-123'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('staticMapAccept', () => {
  it('is image/png only for Standard', () => {
    expect(staticMapAccept('Standard')).toBe('image/png')
  })

  it('is image/jpeg for Satellite', () => {
    expect(staticMapAccept('Satellite')).toBe('image/jpeg')
  })

  it('defaults to image/jpeg when no style is given, because Satellite is the default', () => {
    // The whole trap in one assertion. Guessing image/png here yields a 406 on
    // the most basic possible request.
    expect(staticMapAccept(undefined)).toBe('image/jpeg')
  })
})

describe('buildStaticMapUrl', () => {
  const base = { width: 640, height: 400 } as const

  it('puts the file name in the path and defaults it to map', () => {
    const url = new URL(buildStaticMapUrl(API, { ...base, center: [1, 2] }))
    expect(url.pathname).toBe('/maps/static/map')
  })

  it('honours map@2x for a retina render', () => {
    const url = new URL(
      buildStaticMapUrl(API, { ...base, center: [1, 2], fileName: 'map@2x' }),
    )
    expect(url.pathname).toBe('/maps/static/map@2x')
  })

  it('serialises center as longitude,latitude', () => {
    const url = new URL(
      buildStaticMapUrl(API, { ...base, center: [151.2093, -33.8688] }),
    )
    expect(url.searchParams.get('center')).toBe('151.2093,-33.8688')
  })

  it('serialises boundingBox and bounded positions flat, in kebab-case', () => {
    const bb = new URL(
      buildStaticMapUrl(API, { ...base, boundingBox: [1, 2, 3, 4] }),
    )
    expect(bb.searchParams.get('bounding-box')).toBe('1,2,3,4')

    const bp = new URL(
      buildStaticMapUrl(API, {
        ...base,
        boundedPositions: [
          [1, 2],
          [3, 4],
        ],
      }),
    )
    expect(bp.searchParams.get('bounded-positions')).toBe('1,2,3,4')
  })

  it('emits cropLabels as crop-labels', () => {
    const url = new URL(
      buildStaticMapUrl(API, { ...base, center: [1, 2], cropLabels: true }),
    )
    expect(url.searchParams.get('crop-labels')).toBe('true')
    expect(url.searchParams.has('cropLabels')).toBe(false)
  })

  it('omits absent options rather than sending "undefined"', () => {
    const url = new URL(buildStaticMapUrl(API, { ...base, center: [1, 2] }))
    for (const key of ['zoom', 'style', 'radius', 'padding', 'colorScheme']) {
      expect(url.searchParams.has(key), key).toBe(false)
    }
  })
})

describe('fetchStaticMap', () => {
  function stubFetch(response: Response) {
    const spy = vi.fn(async () => response)
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('sends the bearer token and the Accept matching the style', async () => {
    const spy = stubFetch(new Response(new Blob(['x']), { status: 200 }))

    await fetchStaticMap(
      API,
      { width: 640, height: 400, center: [1, 2], style: 'Standard' },
      token,
    )

    const [, init] = spy.mock.calls[0]!
    expect((init as RequestInit).headers).toEqual({
      Authorization: 'Bearer tok-123',
      Accept: 'image/png',
    })
  })

  it('asks for jpeg when the style is omitted', async () => {
    const spy = stubFetch(new Response(new Blob(['x']), { status: 200 }))

    await fetchStaticMap(
      API,
      { width: 640, height: 400, center: [1, 2] },
      token,
    )

    const [, init] = spy.mock.calls[0]!
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Accept: 'image/jpeg' })
  })

  it('returns the body as a Blob', async () => {
    stubFetch(new Response(new Blob(['png-bytes']), { status: 200 }))
    const blob = await fetchStaticMap(
      API,
      { width: 640, height: 400, center: [1, 2] },
      token,
    )
    expect(blob).toBeInstanceOf(Blob)
    expect(await blob.text()).toBe('png-bytes')
  })

  it('throws the API message rather than a bare status', async () => {
    // A bare "failed: 400" throws away the only useful part. These messages are
    // specific and actionable, so they must survive to the caller.
    stubFetch(
      new Response(
        JSON.stringify({
          message: "'width' and 'height' are required, in pixels",
          code: 'ValidationException',
          requestId: 'req-1',
        }),
        { status: 400, statusText: 'Bad Request' },
      ),
    )

    await expect(
      fetchStaticMap(API, { width: 0, height: 0, center: [1, 2] }, token),
    ).rejects.toThrow(/width.*height.*required/i)
  })
})
