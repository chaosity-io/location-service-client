/**
 * The values Amazon Location accepts for each map parameter.
 *
 * WHY THESE ARE EXPORTED AS VALUES, NOT JUST TYPES
 *
 * A type union gives you compile-time safety and nothing to iterate. Every
 * consumer that renders a style picker then re-types the same list by hand into
 * a `<select>`, and those copies drift the moment AWS adds a style. Exporting
 * the arrays means a dropdown is `MAP_STYLES.map(...)` and cannot disagree with
 * the type beside it.
 *
 * THESE ARE CASE SENSITIVE
 *
 * AWS documents them so, and since location-service-api#89 the API enforces it
 * rather than forwarding a wrong-cased value for Amazon to reject with an
 * unhelpful 404. `'light'` is not `'Light'`:
 *
 *   GET /maps/Standard/descriptor?colorScheme=light
 *   400  "'colorScheme' is case sensitive — use 'Light', not 'light'"
 *
 * So take the values from here rather than typing them, and the case is right
 * by construction.
 *
 * MEMBERSHIP IS NOT THE WHOLE STORY
 *
 * A value being in one of these lists does not mean it is legal in every
 * COMBINATION. `Traffic: 'All'` is valid, and `Style: 'Satellite'` is valid,
 * but together they are not:
 *
 *   400  "Traffic is not supported for style."
 *
 * Amazon owns those rules and answers them per request; the API forwards that
 * message verbatim. Do not try to encode combination rules here — they change
 * without an SDK release.
 *
 * KEEPING THESE HONEST
 *
 * The API derives its copy from the AWS SDK's own `enums.d.ts` via
 * `npm run generate:maps-enums`, so that side cannot drift. This file is the
 * client-side mirror and every value below was additionally confirmed against
 * the live geo-maps API on 2026-08-26. If the API starts rejecting something
 * listed here, its generated list is the authority.
 */

/** Map styles for the style descriptor. */
export const MAP_STYLES = [
  'Hybrid',
  'Monochrome',
  'Satellite',
  'Standard',
] as const
export type MapStyle = (typeof MAP_STYLES)[number]

/**
 * Styles the STATIC map accepts — deliberately narrower than `MAP_STYLES`.
 *
 * `/maps/static/*` takes only Satellite and Standard. Passing Hybrid or
 * Monochrome there is a 400, so the two lists are not interchangeable.
 */
export const STATIC_MAP_STYLES = ['Satellite', 'Standard'] as const
export type StaticMapStyle = (typeof STATIC_MAP_STYLES)[number]

/** Light or dark cartography. Not applicable to the raster styles. */
export const COLOR_SCHEMES = ['Dark', 'Light'] as const
export type ColorScheme = (typeof COLOR_SCHEMES)[number]

/** Terrain overlay. `Hillshade` is shaded relief; `Terrain3D` is elevation. */
export const TERRAINS = ['Hillshade', 'Terrain3D'] as const
export type Terrain = (typeof TERRAINS)[number]

/** 3D building extrusions. One value today, kept a list for when that changes. */
export const BUILDINGS = ['Buildings3D'] as const
export type Buildings = (typeof BUILDINGS)[number]

/**
 * Elevation contour line density.
 *
 * All three work. An earlier version of this library documented `Medium` as
 * "the only value currently supported by the AWS SDK", which was wrong — `High`
 * and `Low` were both confirmed against the live API on 2026-08-26.
 */
export const CONTOUR_DENSITIES = ['High', 'Low', 'Medium'] as const
export type ContourDensity = (typeof CONTOUR_DENSITIES)[number]

/**
 * Traffic overlay.
 *
 * `Congestion` was previously missing from this library's types, so it could
 * not be requested from TypeScript even though the API accepts it.
 */
export const TRAFFIC_MODES = ['All', 'Congestion'] as const
export type TrafficMode = (typeof TRAFFIC_MODES)[number]

/** Routing overlays. Sent as a comma-separated list; each entry is checked. */
export const TRAVEL_MODES = ['Transit', 'Truck'] as const
export type TravelMode = (typeof TRAVEL_MODES)[number]

/** Sprite sheet variant. One value today. */
export const SPRITE_VARIANTS = ['Default'] as const
export type SpriteVariant = (typeof SPRITE_VARIANTS)[number]

/** Static map label size. */
export const LABEL_SIZES = ['Large', 'Small'] as const
export type LabelSize = (typeof LABEL_SIZES)[number]

/** Static map scale bar units. */
export const SCALE_BAR_UNITS = [
  'Kilometers',
  'KilometersMiles',
  'Miles',
  'MilesKilometers',
] as const
export type ScaleBarUnit = (typeof SCALE_BAR_UNITS)[number]

/**
 * Static map points-of-interest rendering.
 *
 * A MODE, not a list of categories — an easy one to get wrong, and the reason
 * the static map route returned a confusing error before
 * location-service-api#35. To filter POIs on an interactive map, use
 * `setPoiVisibility` instead.
 */
export const MAP_FEATURE_MODES = ['Disabled', 'Enabled'] as const
export type MapFeatureMode = (typeof MAP_FEATURE_MODES)[number]
