import type { Map } from 'maplibre-gl'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { POI_CATEGORIES, setAllPoiVisibility } from '../src/maps/mapPoi'

/**
 * POI_CATEGORIES is held to the styles the service serves (#33).
 *
 * AWS publishes no list of a style's layer ids, and the hand-written map
 * missed four of the sixteen `poi*` layers Standard carries — so
 * `setAllPoiVisibility(map, false)` left the small transit icons, the
 * low-zoom park labels and two generic-icon layers on the map. Each fixture
 * is one style's layer list as the service served it, written by
 * `scripts/capture-style-layers.mjs`; re-capture when the styles change.
 */

interface Capture {
  style: string
  colorScheme?: string
  capturedOn: string
  layers: Array<{ id: string; type: string }>
}

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/style-layers',
)
const CAPTURES: Array<[string, Capture]> = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8')) as Capture])

const poiLayers = (c: Capture): string[] =>
  c.layers.filter((l) => l.id.startsWith('poi')).map((l) => l.id)

const claimedBy = (id: string): string[] =>
  Object.entries(POI_CATEGORIES)
    .filter(([, ids]) => (ids as readonly string[]).includes(id))
    .map(([category]) => category)

/** Enough of a MapLibre map to hold the captured layers' visibility. */
function mapOf(c: Capture): { map: Map; visibility: (id: string) => string } {
  const layout = new globalThis.Map(
    c.layers.map((l) => [l.id, 'visible'] as [string, string]),
  )
  const map = {
    getLayer: (id: string) => (layout.has(id) ? { id } : undefined),
    setLayoutProperty: (id: string, name: string, value: string) => {
      if (name === 'visibility' && layout.has(id)) layout.set(id, value)
    },
  } as unknown as Map
  return { map, visibility: (id) => layout.get(id)! }
}

describe('POI_CATEGORIES covers every poi layer of every style', () => {
  it('found the captures, so an empty folder cannot pass', () => {
    expect(CAPTURES.map(([, c]) => c.style)).toEqual(
      expect.arrayContaining(['Standard', 'Monochrome', 'Hybrid']),
    )
    const standard = CAPTURES.find(([, c]) => c.style === 'Standard')![1]
    expect(poiLayers(standard).length).toBeGreaterThanOrEqual(16)
  })

  it.each(CAPTURES)(
    '%s: each poi layer belongs to exactly one category',
    (_file, capture) => {
      const wrong = poiLayers(capture)
        .map((id) => [id, claimedBy(id)] as const)
        .filter(([, by]) => by.length !== 1)
      expect(wrong).toEqual([])
    },
  )

  it.each(CAPTURES)(
    '%s: setAllPoiVisibility(map, false) leaves no poi layer visible',
    (_file, capture) => {
      const { map, visibility } = mapOf(capture)
      setAllPoiVisibility(map, false)
      expect(
        poiLayers(capture).filter((id) => visibility(id) !== 'none'),
      ).toEqual([])
    },
  )

  it('names no layer that no captured style carries', () => {
    const carried = new Set(CAPTURES.flatMap(([, c]) => poiLayers(c)))
    const unknown = Object.values(POI_CATEGORIES)
      .flat()
      .filter((id) => !carried.has(id))
    expect(unknown).toEqual([])
  })
})
