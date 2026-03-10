import type { Map } from 'maplibre-gl'

/**
 * Mapping of POI category names to their MapLibre layer IDs in AWS GeoMaps tiles.
 * Layer IDs are stable across Standard, Monochrome, and Hybrid map styles.
 */
export const POI_CATEGORIES = {
  food_drink: ['poi_100_food_drink'],
  entertainment: ['poi_200_going_out_entertainment'],
  sights: ['poi_300_sights_museums'],
  transit: ['poi_400_transit'],
  accommodations: ['poi_500_accommodations'],
  leisure: ['poi_550_leisure_outdoor'],
  shopping: ['poi_600_shopping'],
  business: ['poi_700_business_services'],
  facilities: ['poi_800_facilities'],
  areas: ['poi_900_areas_buildings'],
  parks: ['poi_landuse_park', 'poi_landuse_public_complex'],
} as const

export type PoiCategory = keyof typeof POI_CATEGORIES

/**
 * Set the visibility of one or more POI categories on the map.
 *
 * @param map - MapLibre Map instance
 * @param category - POI category key or array of keys
 * @param visible - Whether to show (true) or hide (false) the category
 *
 * @example
 * // Hide transit and shopping POIs
 * setPoiVisibility(map, ['transit', 'shopping'], false)
 *
 * // Show all food & drink POIs
 * setPoiVisibility(map, 'food_drink', true)
 */
export function setPoiVisibility(
  map: Map,
  category: PoiCategory | PoiCategory[],
  visible: boolean
): void {
  const categories = Array.isArray(category) ? category : [category]
  const visibility = visible ? 'visible' : 'none'

  for (const cat of categories) {
    for (const layerId of POI_CATEGORIES[cat]) {
      try {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', visibility)
        }
      } catch {
        // Layer may not exist in the current map style
      }
    }
  }
}

/**
 * Show or hide all POI layers at once.
 *
 * @param map - MapLibre Map instance
 * @param visible - Whether to show or hide all POIs
 *
 * @example
 * setAllPoiVisibility(map, false) // hide everything
 */
export function setAllPoiVisibility(map: Map, visible: boolean): void {
  setPoiVisibility(map, Object.keys(POI_CATEGORIES) as PoiCategory[], visible)
}
