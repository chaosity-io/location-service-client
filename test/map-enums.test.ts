import { describe, expect, it } from 'vitest'

import {
  BUILDINGS,
  COLOR_SCHEMES,
  CONTOUR_DENSITIES,
  LABEL_SIZES,
  MAP_FEATURE_MODES,
  MAP_STYLES,
  SCALE_BAR_UNITS,
  SPRITE_VARIANTS,
  STATIC_MAP_STYLES,
  TERRAINS,
  TRAFFIC_MODES,
  TRAVEL_MODES,
  buildMapStyleUrl,
} from '../src/index'

/**
 * The accepted values for every map parameter.
 *
 * These mirror the API's generated lists, which are derived from the AWS SDK's
 * own `enums.d.ts`. Two sources describing one thing is a drift risk, so the
 * values are pinned here rather than merely typed — if AWS adds a style and the
 * API regenerates, this suite fails and says so out loud.
 *
 * Every value was confirmed against the live geo-maps API on 2026-08-26.
 */

describe('the accepted values, pinned', () => {
  it.each([
    [
      'MAP_STYLES',
      MAP_STYLES,
      ['Hybrid', 'Monochrome', 'Satellite', 'Standard'],
    ],
    ['STATIC_MAP_STYLES', STATIC_MAP_STYLES, ['Satellite', 'Standard']],
    ['COLOR_SCHEMES', COLOR_SCHEMES, ['Dark', 'Light']],
    ['TERRAINS', TERRAINS, ['Hillshade', 'Terrain3D']],
    ['BUILDINGS', BUILDINGS, ['Buildings3D']],
    ['CONTOUR_DENSITIES', CONTOUR_DENSITIES, ['High', 'Low', 'Medium']],
    ['TRAFFIC_MODES', TRAFFIC_MODES, ['All', 'Congestion']],
    ['TRAVEL_MODES', TRAVEL_MODES, ['Transit', 'Truck']],
    ['SPRITE_VARIANTS', SPRITE_VARIANTS, ['Default']],
    ['LABEL_SIZES', LABEL_SIZES, ['Large', 'Small']],
    [
      'SCALE_BAR_UNITS',
      SCALE_BAR_UNITS,
      ['Kilometers', 'KilometersMiles', 'Miles', 'MilesKilometers'],
    ],
    ['MAP_FEATURE_MODES', MAP_FEATURE_MODES, ['Disabled', 'Enabled']],
  ])('%s', (_name, actual, expected) => {
    expect([...actual]).toEqual(expected)
  })
})

describe('the corrections this module exists to make', () => {
  it('offers all three contour densities, not just Medium', () => {
    // Previously typed as `'Medium'` alone and documented as "the only value
    // currently supported by the AWS SDK". High and Low both work.
    expect(CONTOUR_DENSITIES).toContain('High')
    expect(CONTOUR_DENSITIES).toContain('Low')
  })

  it('offers Congestion, which could not be requested before', () => {
    expect(TRAFFIC_MODES).toContain('Congestion')
  })

  it('keeps the static map style list narrower than the descriptor one', () => {
    // /maps/static/* takes only Satellite and Standard; passing Hybrid or
    // Monochrome there is a 400. The two lists are not interchangeable.
    expect(STATIC_MAP_STYLES.length).toBeLessThan(MAP_STYLES.length)
    for (const s of STATIC_MAP_STYLES) expect(MAP_STYLES).toContain(s)
    expect(MAP_STYLES).toContain('Hybrid')
    expect(STATIC_MAP_STYLES).not.toContain('Hybrid')
  })
})

describe('every value is spelled the way the API demands', () => {
  it('has no value that differs from another only by case', () => {
    // The API is case sensitive and rejects a wrong-cased value. A list holding
    // both `Light` and `light` would make that impossible to reason about.
    for (const list of [
      MAP_STYLES,
      COLOR_SCHEMES,
      TERRAINS,
      CONTOUR_DENSITIES,
      TRAFFIC_MODES,
      TRAVEL_MODES,
    ]) {
      const lowered = list.map((v) => v.toLowerCase())
      expect(new Set(lowered).size).toBe(list.length)
    }
  })

  // Each case is wrapped in its own array: it.each spreads a top-level array
  // into the test's arguments, so a bare list would arrive as its first string.
  it.each([
    [MAP_STYLES],
    [COLOR_SCHEMES],
    [TERRAINS],
    [CONTOUR_DENSITIES],
    [TRAFFIC_MODES],
    [TRAVEL_MODES],
    [LABEL_SIZES],
    [SCALE_BAR_UNITS],
    [MAP_FEATURE_MODES],
  ])('starts every value with a capital, as Amazon spells them', (list) => {
    for (const v of list) expect(v[0]).toBe(v[0].toUpperCase())
  })
})

describe('the values reach the URL unchanged', () => {
  it('sends the exact spelling as query parameters', () => {
    // The point of exporting values: what the picker offers is what is sent.
    const url = buildMapStyleUrl('https://api.example.com', 'Standard', {
      colorScheme: 'Dark',
      terrain: 'Terrain3D',
      contourDensity: 'High',
      traffic: 'Congestion',
      travelModes: ['Truck', 'Transit'],
    })

    expect(url).toContain('color-scheme=Dark')
    expect(url).toContain('terrain=Terrain3D')
    expect(url).toContain('contour-density=High')
    expect(url).toContain('traffic=Congestion')
    // A list goes over the wire comma-separated; the API checks each element.
    expect(decodeURIComponent(url)).toContain('travel-modes=Truck,Transit')
  })

  it('omits what was not asked for', () => {
    const url = buildMapStyleUrl('https://api.example.com', 'Satellite')
    expect(url).toBe('https://api.example.com/maps/Satellite/descriptor')
  })
})
