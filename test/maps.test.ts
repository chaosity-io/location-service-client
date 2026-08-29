import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocationServiceException } from '../src/errors/LocationServiceException'
import { createTransformRequest } from '../src/maps/createTransformRequest'
import { applyMapLanguage } from '../src/maps/mapLanguage'
import {
  POI_CATEGORIES,
  setAllPoiVisibility,
  setPoiVisibility,
} from '../src/maps/mapPoi'
import { buildMapStyleUrl, fetchMapStyle } from '../src/maps/mapStyle'
import { transformRequest } from '../src/maps/Utils'

/**
 * The maps module was entirely at 0% (#6 / T35).
 *
 * createTransformRequest carries the most weight of anything here, and it is
 * not obvious why: api#82 established that the API returns base64 TEXT instead
 * of a tile to any client that does not send a matching `Accept` header. Every
 * map that works does so because this function sets it. If these headers drift,
 * tiles do not fail — they arrive as unparseable text.
 *
 * The other property worth guarding is that the token is attached ONLY to our
 * own apiUrl. A transformRequest that stamped Authorization onto every URL
 * MapLibre fetches would hand the customer's bearer token to any third-party
 * host in a style.
 */

const API = 'https://api.test'
const token = () => 'tok-123'

describe('createTransformRequest: the Accept header the API depends on', () => {
  const t = createTransformRequest(API, token)

  it.each([
    [
      'tiles',
      `${API}/maps/tiles/vector.basemap/1/2/3`,
      'application/x-protobuf',
    ],
    ['glyphs', `${API}/maps/glyphs/Font/0-255.pbf`, 'application/x-protobuf'],
    [
      'sprite png',
      `${API}/maps/styles/Standard/Light/Default/sprites/sprites.png`,
      'image/png',
    ],
    [
      'sprite json',
      `${API}/maps/styles/Standard/Light/Default/sprites/sprites.json`,
      'application/json',
    ],
    ['descriptor', `${API}/maps/Standard/descriptor`, 'application/json'],
  ])('sends %s as %s', (_label, url, expected) => {
    expect(t(url)?.headers?.Accept).toBe(expected)
  })

  it('attaches the bearer token to our own API', () => {
    expect(
      t(`${API}/maps/tiles/vector.basemap/1/2/3`)?.headers?.Authorization,
    ).toBe('Bearer tok-123')
  })

  it('does NOT touch a URL that is not ours', () => {
    // A style can reference third-party hosts. Stamping the customer's token
    // onto those would hand it to someone else entirely.
    const out = t('https://tiles.example.com/1/2/3')
    expect(out).toEqual({ url: 'https://tiles.example.com/1/2/3' })
    expect(out?.headers).toBeUndefined()
  })

  it('returns the url unchanged when there is no token yet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noToken = createTransformRequest(API, () => undefined)

    const out = noToken(`${API}/maps/tiles/vector.basemap/1/2/3`)

    expect(out).toEqual({ url: `${API}/maps/tiles/vector.basemap/1/2/3` })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('Utils.transformRequest prefers a live token over a static one', () => {
  it('calls getToken when the config provides it', () => {
    const out = transformRequest(`${API}/maps/tiles/a/1/2/3`, {
      apiUrl: API,
      token: 'stale',
      getToken: () => 'fresh',
    } as never)
    expect(out?.headers?.Authorization).toBe('Bearer fresh')
  })

  it('falls back to the static token', () => {
    const out = transformRequest(`${API}/maps/tiles/a/1/2/3`, {
      apiUrl: API,
      token: 'static',
    } as never)
    expect(out?.headers?.Authorization).toBe('Bearer static')
  })
})

describe('buildMapStyleUrl', () => {
  it('emits nothing but the path when no options are given', () => {
    expect(buildMapStyleUrl(API, 'Standard')).toBe(
      `${API}/maps/Standard/descriptor`,
    )
  })

  it('uses kebab-case on the wire, not the camelCase option names', () => {
    const url = buildMapStyleUrl(API, 'Standard', {
      colorScheme: 'Dark',
      politicalView: 'IND',
      contourDensity: 'Medium',
    })
    expect(url).toContain('color-scheme=Dark')
    expect(url).toContain('political-view=IND')
    expect(url).toContain('contour-density=Medium')
  })

  it('joins travel modes into one parameter', () => {
    expect(
      buildMapStyleUrl(API, 'Standard', {
        travelModes: ['Car', 'Truck'],
      } as never),
    ).toContain('travel-modes=Car%2CTruck')
  })

  it('omits an empty travel-modes list rather than sending a blank', () => {
    expect(
      buildMapStyleUrl(API, 'Standard', { travelModes: [] } as never),
    ).toBe(`${API}/maps/Standard/descriptor`)
  })

  it('asks for terrain, which is what makes the DEM source appear (api#39)', () => {
    expect(
      buildMapStyleUrl(API, 'Standard', { terrain: 'Terrain3D' } as never),
    ).toContain('terrain=Terrain3D')
  })
})

describe('fetchMapStyle', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  const descriptor = (layers: unknown[] = []) =>
    new Response(JSON.stringify({ version: 8, sources: {}, layers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async () => descriptor())
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the token and asks for json', async () => {
    await fetchMapStyle(API, 'Standard', token)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer tok-123')
    expect(init.headers.Accept).toBe('application/json')
  })

  it('carries the status when the API refuses', async () => {
    // The status used to be asserted through the MESSAGE, because the message
    // was built from the status and nothing else. It is structural now: the
    // message carries what the server actually said, which for our error
    // envelope is Amazon's own sentence (see map-style-errors.test.ts).
    fetchMock.mockImplementation(
      async () =>
        new Response('nope', { status: 403, statusText: 'Forbidden' }),
    )

    const err = await fetchMapStyle(API, 'Standard', token).catch(
      (e: unknown) => e as LocationServiceException,
    )
    expect(err).toBeInstanceOf(LocationServiceException)
    expect(err.statusCode).toBe(403)
    // A non-JSON body is echoed rather than discarded — it is what the server
    // chose to say.
    expect(err.message).toContain('nope')
  })

  it('rewrites text-field on symbol layers for the requested language', async () => {
    fetchMock.mockImplementation(async () =>
      descriptor([
        { id: 'a', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
        { id: 'b', type: 'line', layout: {} },
      ]),
    )

    const style = await fetchMapStyle(API, 'Standard', token, {
      language: 'fr',
    })
    const [symbol, line] = style.layers as never[]

    expect(symbol.layout['text-field']).toEqual([
      'coalesce',
      ['get', 'name:fr'],
      ['get', 'name:en'],
      ['get', 'name'],
    ])
    // A non-symbol layer must be left exactly as it was.
    expect(line.layout).toEqual({})
  })

  it('uses the shorter expression for English', async () => {
    fetchMock.mockImplementation(async () =>
      descriptor([
        { id: 'a', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
      ]),
    )
    const style = await fetchMapStyle(API, 'Standard', token, {
      language: 'en',
    })
    expect((style.layers as never[])[0].layout['text-field']).toEqual([
      'coalesce',
      ['get', 'name:en'],
      ['get', 'name'],
    ])
  })

  it('leaves a symbol layer with no text-field alone', async () => {
    fetchMock.mockImplementation(async () =>
      descriptor([{ id: 'a', type: 'symbol', layout: { 'icon-image': 'x' } }]),
    )
    const style = await fetchMapStyle(API, 'Standard', token, {
      language: 'fr',
    })
    expect((style.layers as never[])[0].layout).toEqual({ 'icon-image': 'x' })
  })

  it('does not touch layers when no language is asked for', async () => {
    fetchMock.mockImplementation(async () =>
      descriptor([
        { id: 'a', type: 'symbol', layout: { 'text-field': ['get', 'name'] } },
      ]),
    )
    const style = await fetchMapStyle(API, 'Standard', token)
    expect((style.layers as never[])[0].layout['text-field']).toEqual([
      'get',
      'name',
    ])
  })

  it('leaves house numbers and road shields alone — they do not label by name (#28)', async () => {
    // The three shapes as the AWS Standard descriptor declares them. Before
    // the fix all three became the name coalesce, and the two non-name layers
    // then read a property their features do not have: house numbers and
    // shields vanished from every map that asked for a language, `en`
    // included.
    const houseNumber = ['to-string', ['get', 'addr_housenumber']]
    const shield = ['to-string', ['get', 'shield_text']]
    fetchMock.mockImplementation(async () =>
      descriptor([
        {
          id: 'building_label_number',
          type: 'symbol',
          layout: { 'text-field': houseNumber },
        },
        {
          id: 'shield_generic',
          type: 'symbol',
          layout: { 'text-field': shield },
        },
        {
          id: 'place_label',
          type: 'symbol',
          layout: {
            'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          },
        },
      ]),
    )

    const style = await fetchMapStyle(API, 'Standard', token, {
      language: 'fr',
    })
    const [number, shieldLayer, place] = style.layers as never[]

    expect(number.layout['text-field']).toEqual(houseNumber)
    expect(shieldLayer.layout['text-field']).toEqual(shield)
    expect(place.layout['text-field']).toEqual([
      'coalesce',
      ['get', 'name:fr'],
      ['get', 'name:en'],
      ['get', 'name'],
    ])
  })
})

describe('POI visibility', () => {
  const fakeMap = () => {
    const set = vi.fn()
    return {
      map: {
        getLayer: (id: string) => ({ id }),
        setLayoutProperty: set,
      } as never,
      set,
    }
  }

  it('maps a category to its layer ids', () => {
    const { map, set } = fakeMap()
    setPoiVisibility(map, 'food_drink', false)
    expect(set).toHaveBeenCalledWith('poi_100_food_drink', 'visibility', 'none')
  })

  it('accepts several categories at once', () => {
    const { map, set } = fakeMap()
    setPoiVisibility(map, ['transit', 'shopping'], true)
    expect(set).toHaveBeenCalledWith('poi_400_transit', 'visibility', 'visible')
    expect(set).toHaveBeenCalledWith(
      'poi_600_shopping',
      'visibility',
      'visible',
    )
  })

  it('handles a category backed by more than one layer', () => {
    const { map, set } = fakeMap()
    setPoiVisibility(map, 'parks', false)
    expect(set).toHaveBeenCalledTimes(2)
  })

  it('skips a layer the current style does not have', () => {
    const set = vi.fn()
    setPoiVisibility(
      { getLayer: () => undefined, setLayoutProperty: set } as never,
      'transit',
      false,
    )
    expect(set).not.toHaveBeenCalled()
  })

  it('survives a map that throws, because the style may still be loading', () => {
    const throwing = {
      getLayer: () => {
        throw new Error('style not ready')
      },
      setLayoutProperty: vi.fn(),
    } as never
    expect(() => setPoiVisibility(throwing, 'transit', false)).not.toThrow()
  })

  it('setAllPoiVisibility covers every declared category', () => {
    const { map, set } = fakeMap()
    setAllPoiVisibility(map, false)
    const expected = Object.values(POI_CATEGORIES).flat().length
    expect(set).toHaveBeenCalledTimes(expected)
  })
})

describe('applyMapLanguage on a live map', () => {
  const mapWith = (
    layers: { id: string; type: string }[],
    textField: unknown,
  ) => {
    const setLayoutProperty = vi.fn()
    return {
      map: {
        getStyle: () => ({ layers }),
        getLayoutProperty: () => textField,
        setLayoutProperty,
      } as never,
      setLayoutProperty,
    }
  }

  it('rewrites symbol layers that have a text-field', () => {
    const { map, setLayoutProperty } = mapWith(
      [{ id: 'a', type: 'symbol' }],
      ['get', 'name'],
    )
    applyMapLanguage(map, 'de')
    expect(setLayoutProperty).toHaveBeenCalledWith('a', 'text-field', [
      'coalesce',
      ['get', 'name:de'],
      ['get', 'name:en'],
      ['get', 'name'],
    ])
  })

  it('leaves non-symbol layers alone', () => {
    const { map, setLayoutProperty } = mapWith(
      [{ id: 'a', type: 'line' }],
      ['get', 'name'],
    )
    applyMapLanguage(map, 'de')
    expect(setLayoutProperty).not.toHaveBeenCalled()
  })

  it('skips a symbol layer whose text-field is absent', () => {
    const { map, setLayoutProperty } = mapWith(
      [{ id: 'a', type: 'symbol' }],
      undefined,
    )
    applyMapLanguage(map, 'de')
    expect(setLayoutProperty).not.toHaveBeenCalled()
  })

  it('skips a symbol layer that does not label by name (#28)', () => {
    // A live-map language switch has the same rule as the descriptor rewrite:
    // a house-number or shield layer keeps its own text-field.
    const { map, setLayoutProperty } = mapWith(
      [{ id: 'building_label_number', type: 'symbol' }],
      ['to-string', ['get', 'addr_housenumber']],
    )
    applyMapLanguage(map, 'de')
    expect(setLayoutProperty).not.toHaveBeenCalled()
  })

  it('swallows a style that is not loaded yet', () => {
    expect(() =>
      applyMapLanguage(
        {
          getStyle: () => {
            throw new Error('not ready')
          },
        } as never,
        'de',
      ),
    ).not.toThrow()
  })
})
