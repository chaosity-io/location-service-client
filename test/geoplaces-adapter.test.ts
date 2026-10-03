import { describe, expect, it } from 'vitest'
import { GeoPlaces } from '../src/adapters/GeoPlaces'
import type { GeoPlacesClient } from '../src/client/GeoPlacesClient'

/** What GeoPlaces takes: anything with the client's `send` (#65). */
type SendOnly = Pick<GeoPlacesClient, 'send'>

/**
 * What the geocoder adapter asks Amazon Location for, and what that costs
 * (#3 / T19, finding A-9).
 *
 * Buckets measured directly against Amazon Location on 2026-08-25 by sending
 * each variant and reading `PricingBucket` back:
 *
 *   Suggest with [Core]          -> Core      $0.50/1k
 *   Suggest with nothing         -> Label     $0.20/1k
 *   GetPlace all four features   -> Advanced  $1.50/1k
 *   GetPlace none                -> Core      $0.50/1k
 *   GetPlace SecondaryAddresses  -> Core      $0.50/1k
 *   GetPlace Access|Contact|TimeZone (any) -> Advanced $1.50/1k
 */

const sent: { name: string; input: Record<string, unknown> }[] = []

const fakeClient = {
  send: async (cmd: { constructor: { name: string }; input: unknown }) => {
    sent.push({
      name: cmd.constructor.name,
      input: cmd.input as Record<string, unknown>,
    })
    return { ResultItems: [], Title: '', Address: {}, Position: [0, 0] }
  },
} as unknown as SendOnly

const fakeMap = { getCenter: () => ({ lng: 151.209, lat: -33.869 }) }

const adapter = (options?: ConstructorParameters<typeof GeoPlaces>[2]) =>
  new GeoPlaces(fakeClient, fakeMap as never, options)

const lastInput = () => sent[sent.length - 1]!.input

describe('Suggest lands in the Label bucket', () => {
  it('sends no AdditionalFeatures at all', async () => {
    // It used to send [Core] on every keystroke — $0.50/1k — while reading
    // only Title and Place.PlaceId from the response. Core's sole addition to
    // a Suggest result is `Highlights`, which this adapter never touches.
    sent.length = 0
    await adapter().getSuggestions({ query: 'martin pl' } as never)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.name).toBe('SuggestCommand')
    expect(lastInput()).not.toHaveProperty('AdditionalFeatures')
  })

  it('still sends the bias position and query', async () => {
    sent.length = 0
    await adapter().getSuggestions({ query: 'martin pl' } as never)
    expect(lastInput().QueryText).toBe('martin pl')
    expect(lastInput().BiasPosition).toBeDefined()
  })

  it('still honours a caller country filter', async () => {
    sent.length = 0
    await adapter().getSuggestions({
      query: 'queen st',
      countries: 'NZ',
    } as never)
    expect(lastInput().Filter).toEqual({ IncludeCountries: ['NZ'] })
  })
})

describe('GetPlace detail is opt-in, so the default stays in Core', () => {
  it('sends no AdditionalFeatures when nothing is requested', async () => {
    // The default used to be Access + SecondaryAddresses + Contact + TimeZone,
    // which is the Advanced bucket at 3x the price, on every detail lookup.
    sent.length = 0
    await adapter().searchByPlaceId({ query: 'place-1' } as never)

    expect(sent[0]!.name).toBe('GetPlaceCommand')
    expect(lastInput()).not.toHaveProperty('AdditionalFeatures')
  })

  it('sends only what the caller opted into', async () => {
    sent.length = 0
    await adapter({ details: { timeZone: true } }).searchByPlaceId({
      query: 'place-1',
    } as never)
    expect(lastInput().AdditionalFeatures).toEqual(['TimeZone'])
  })

  it('keeps the address form working: SecondaryAddresses alone stays Core', async () => {
    // The one feature of the four that does NOT move the bucket, so enabling
    // it is free. This is the case the address form needs.
    sent.length = 0
    await adapter({ details: { secondaryAddresses: true } }).searchByPlaceId({
      query: 'place-1',
    } as never)
    expect(lastInput().AdditionalFeatures).toEqual(['SecondaryAddresses'])
  })

  it('can still request everything, for callers that want it', async () => {
    sent.length = 0
    await adapter({
      details: {
        access: true,
        secondaryAddresses: true,
        contact: true,
        timeZone: true,
      },
    }).searchByPlaceId({ query: 'place-1' } as never)

    expect(lastInput().AdditionalFeatures).toEqual([
      'Access',
      'SecondaryAddresses',
      'Contact',
      'TimeZone',
    ])
  })

  it('omits the field rather than sending an empty array', async () => {
    // An empty array is still a field on the request; the point is to send
    // nothing at all.
    sent.length = 0
    await adapter({ details: {} }).searchByPlaceId({
      query: 'place-1',
    } as never)
    expect(lastInput().AdditionalFeatures).toBeUndefined()
  })
})

/**
 * The control is a Carmen-shaped consumer. Its result list renders
 * `item.place_name.split(',')`, the input takes `place_name` on select, and
 * fly-to reads `center` / `bbox`. The AWS converters emit plain GeoJSON, so a
 * forward geocode used to return features with NO `place_name` — the list
 * renderer threw, the control emitted `error` with nobody listening, and the
 * Enter key silently did nothing (`Unhandled error. (undefined)` in the
 * console). Found by driving the testbed, not by a test — which is why these
 * exist. Suggestions never broke, because that path renders `text`.
 */
describe('results carry what the geocoder control renders', () => {
  // The shape Amazon returns for "Circular Quay" with an AU filter, trimmed.
  const item = (over: Record<string, unknown> = {}) => ({
    PlaceId: 'AQAA-1',
    PlaceType: 'Street',
    Title: 'Circular Quay, Sydney NSW 2000, Australia',
    Address: {
      Label: 'Circular Quay, Sydney NSW 2000, Australia',
      Country: { Code2: 'AU', Code3: 'AUS', Name: 'Australia' },
      Locality: 'Sydney',
    },
    Position: [151.21284, -33.85985],
    MapView: [151.2117, -33.8611, 151.2141, -33.8586],
    Distance: 1500,
    ...over,
  })

  const clientReturning = (response: unknown) =>
    ({ send: async () => response }) as unknown as SendOnly

  it('forward geocode: place_name, text, place_type, center and bbox are present', async () => {
    const gp = new GeoPlaces(
      clientReturning({ ResultItems: [item()] }),
      fakeMap as never,
    )
    const { features } = await gp.forwardGeocode({
      query: 'Circular Quay',
    } as never)

    expect(features).toHaveLength(1)
    const f = features[0]!
    expect(f.place_name).toBe('Circular Quay, Sydney NSW 2000, Australia')
    expect(f.text).toBe('Circular Quay, Sydney NSW 2000, Australia')
    expect(f.place_type).toEqual(['Street'])
    expect(f.center).toEqual([151.21284, -33.85985])
    expect(f.bbox).toEqual([151.2117, -33.8611, 151.2141, -33.8586])
    // Still a valid GeoJSON feature underneath.
    expect(f.geometry).toEqual({
      type: 'Point',
      coordinates: [151.21284, -33.85985],
    })
  })

  it('survives what the list renderer does to it', async () => {
    // This is the exact expression that threw.
    const gp = new GeoPlaces(
      clientReturning({ ResultItems: [item()] }),
      fakeMap as never,
    )
    const { features } = await gp.forwardGeocode({ query: 'x' } as never)
    expect(() => features[0]!.place_name.split(',')).not.toThrow()
  })

  it('falls back to Title when there is no address label', async () => {
    const gp = new GeoPlaces(
      clientReturning({
        ResultItems: [item({ Address: { Country: { Code2: 'AU' } } })],
      }),
      fakeMap as never,
    )
    const { features } = await gp.forwardGeocode({ query: 'x' } as never)
    expect(features[0]!.place_name).toBe(
      'Circular Quay, Sydney NSW 2000, Australia',
    )
  })

  it('omits bbox when Amazon sends no MapView, rather than inventing one', async () => {
    const gp = new GeoPlaces(
      clientReturning({ ResultItems: [item({ MapView: undefined })] }),
      fakeMap as never,
    )
    const { features } = await gp.forwardGeocode({ query: 'x' } as never)
    expect(features[0]).not.toHaveProperty('bbox')
    expect(features[0]!.center).toEqual([151.21284, -33.85985])
  })

  it('reverse geocode gets the same treatment', async () => {
    const gp = new GeoPlaces(
      clientReturning({ ResultItems: [item()] }),
      fakeMap as never,
    )
    const { features } = await gp.reverseGeocode({
      query: [151.2093, -33.8688],
    } as never)
    expect(features[0]!.place_name).toBe(
      'Circular Quay, Sydney NSW 2000, Australia',
    )
    expect(features[0]!.place_type).toEqual(['Street'])
  })

  it('an empty result is an empty collection, not a crash', async () => {
    const gp = new GeoPlaces(
      clientReturning({ ResultItems: [] }),
      fakeMap as never,
    )
    const result = await gp.forwardGeocode({ query: 'zzz' } as never)
    expect(result).toEqual({ type: 'FeatureCollection', features: [] })
  })
})

/**
 * A geocoder `bbox` (#59).
 *
 * Suggest takes exactly one of `BiasPosition`, `Filter.BoundingBox` and
 * `Filter.Circle`, and answers anything else 400 ValidationException: "Exactly
 * one of the following fields must be set". `getSuggestions` always sent a
 * bias, and added the box beside it when the control carried one, so an
 * integrator who set MapLibre Geocoder's `bbox` saw no suggestions at all.
 * Geocode has no box filter, so `forwardGeocode` sent none and returned
 * whatever the bias found, outside the box included.
 */
describe('a geocoder bbox', () => {
  const box = [152.95, -27.55, 153.1, -27.4]

  it('getSuggestions with a bbox sends Filter.BoundingBox and no BiasPosition', async () => {
    sent.length = 0
    await adapter().getSuggestions({
      query: 'george st',
      bbox: box,
      proximity: [151.209, -33.869],
    } as never)
    expect(lastInput()).not.toHaveProperty('BiasPosition')
    expect(lastInput().Filter).toEqual({ BoundingBox: box })
  })

  it('keeps a country filter beside the box', async () => {
    sent.length = 0
    await adapter().getSuggestions({
      query: 'george st',
      bbox: box,
      countries: 'AU,NZ',
    } as never)
    expect(lastInput()).not.toHaveProperty('BiasPosition')
    expect(lastInput().Filter).toEqual({
      BoundingBox: box,
      IncludeCountries: ['AU', 'NZ'],
    })
  })

  it('getSuggestions without a bbox sends BiasPosition: proximity, else the map centre', async () => {
    sent.length = 0
    await adapter().getSuggestions({
      query: 'george st',
      proximity: [150.5, -34.1],
    } as never)
    expect(lastInput().BiasPosition).toEqual([150.5, -34.1])
    expect(lastInput()).not.toHaveProperty('Filter')

    await adapter().getSuggestions({ query: 'george st' } as never)
    expect(lastInput().BiasPosition).toEqual([151.209, -33.869])
  })

  describe('forwardGeocode', () => {
    const at = (Position: [number, number]) => ({
      PlaceId: `p-${Position.join(',')}`,
      PlaceType: 'Street',
      Title: `George St ${Position.join(',')}`,
      Address: { Label: `George St ${Position.join(',')}` },
      Position,
    })
    const clientReturning = (ResultItems: unknown[]) =>
      ({ send: async () => ({ ResultItems }) }) as unknown as SendOnly

    it('drops results outside the bbox', async () => {
      const gp = new GeoPlaces(
        clientReturning([
          at([151.20691, -33.86974]), // Sydney
          at([153.02351, -27.47092]), // inside
          at([153.20172, -27.71601]), // east and south of it
        ]),
        fakeMap as never,
      )
      const { features } = await gp.forwardGeocode({
        query: 'George St',
        bbox: box,
      } as never)
      expect(features.map((f) => f.center)).toEqual([[153.02351, -27.47092]])
    })

    it('keeps a result on the edge of the box', async () => {
      const gp = new GeoPlaces(
        clientReturning([at([152.95, -27.4])]),
        fakeMap as never,
      )
      const { features } = await gp.forwardGeocode({
        query: 'George St',
        bbox: box,
      } as never)
      expect(features).toHaveLength(1)
    })

    it('reads a box that crosses the antimeridian as the box it is', async () => {
      // [minX, minY, maxX, maxY] with minX > maxX: from 170° east across
      // 180° to 170° west.
      const gp = new GeoPlaces(
        clientReturning([at([175, -40]), at([-175, -40]), at([0, -40])]),
        fakeMap as never,
      )
      const { features } = await gp.forwardGeocode({
        query: 'x',
        bbox: [170, -45, -170, -35],
      } as never)
      expect(features.map((f) => f.center)).toEqual([
        [175, -40],
        [-175, -40],
      ])
    })

    it('returns everything when there is no bbox', async () => {
      const gp = new GeoPlaces(
        clientReturning([at([151.20691, -33.86974]), at([153.02, -27.47])]),
        fakeMap as never,
      )
      const { features } = await gp.forwardGeocode({ query: 'x' } as never)
      expect(features).toHaveLength(2)
    })
  })
})
