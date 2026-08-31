import type { MapLike } from '../types/index.js'

/**
 * The `text-field` expression that prefers `language`, then English, then the
 * feature's default name.
 *
 * Based on the approach documented at:
 * https://docs.aws.amazon.com/location/latest/developerguide/how-to-set-preferred-language-map.html
 */
export function languageExpression(language: string): unknown[] {
  return language === 'en'
    ? ['coalesce', ['get', 'name:en'], ['get', 'name']]
    : [
        'coalesce',
        ['get', `name:${language}`],
        ['get', 'name:en'],
        ['get', 'name'],
      ]
}

/**
 * Whether a `text-field` reads a name property — the only kind of label a
 * language rewrite makes sense for (#28).
 *
 * The AWS Standard style has 62 symbol layers with a text-field and 30 of
 * them do NOT label by name: `building_label_number` reads
 * `addr_housenumber`, and the 29 `shield_*` layers read `shield_text` or
 * `ref`. Replacing those with a `name:<lang>` coalesce points them at a
 * property their features do not carry, and the house numbers and road
 * shields disappear — for `en` too. Measured against the live sandbox on
 * 2026-08-29; the testbed showed it as "one map has house numbers, the
 * others don't".
 *
 * Serialising the expression is the simplest exact test: `name`, `name:en`,
 * `name_en` and a literal `{name}` template all contain it, and none of the
 * non-name properties do.
 */
export function labelsByName(textField: unknown): boolean {
  return JSON.stringify(textField)?.includes('name') ?? false
}

/**
 * Apply a preferred display language to the name labels on a MapLibre map.
 *
 * AWS GeoMaps vector tiles carry `name:${lang}` properties (`name:en`,
 * `name:fr`, `name:ja`, …). Every symbol layer whose `text-field` reads a
 * name is rewritten to prefer the requested language, falling back to
 * English then the default name. Layers that label by something else — house
 * numbers, road shields — are left exactly as the style declared them.
 *
 * @param map - MapLibre Map instance (or any object matching the MapLike interface)
 * @param language - ISO 639-1 language code (e.g. 'en', 'fr', 'de', 'ja', 'zh', 'ar')
 *
 * @example
 * map.once('style.load', () => applyMapLanguage(map, 'fr'))
 */
export function applyMapLanguage(map: MapLike, language: string): void {
  try {
    const expression = languageExpression(language)

    map.getStyle().layers.forEach((layer) => {
      if (layer.type !== 'symbol') return
      const textField = map.getLayoutProperty(layer.id, 'text-field')
      if (textField === undefined || textField === null) return
      if (!labelsByName(textField)) return
      map.setLayoutProperty(layer.id, 'text-field', expression)
    })
  } catch {
    // Style may not be fully loaded — call after 'style.load' event
  }
}
