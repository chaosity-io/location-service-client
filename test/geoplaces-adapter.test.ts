import { describe, expect, it } from 'vitest'
import { GeoPlaces } from '../src/adapters/GeoPlaces'
import type { GeoPlacesClient } from '../src/client/GeoPlacesClient'

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
} as unknown as GeoPlacesClient

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
