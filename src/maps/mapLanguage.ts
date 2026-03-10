import type { Map } from 'maplibre-gl'

/**
 * Apply a preferred display language to all symbol layers on a MapLibre map.
 *
 * AWS GeoMaps vector tiles include language-specific name properties in `name:${lang}` format
 * (e.g. `name:en`, `name:fr`, `name:ja`). This function updates the `text-field` expression
 * on every symbol layer to prefer the requested language, falling back to English then the
 * default name if the preferred language is unavailable for a feature.
 *
 * Based on the approach documented at:
 * https://docs.aws.amazon.com/location/latest/developerguide/how-to-set-preferred-language-map.html
 *
 * @param map - MapLibre Map instance
 * @param language - ISO 639-1 language code (e.g. 'en', 'fr', 'de', 'ja', 'zh', 'ar')
 *
 * @example
 * map.once('style.load', () => applyMapLanguage(map, 'fr'))
 */
export function applyMapLanguage(map: Map, language: string): void {
  try {
    const expression =
      language === 'en'
        ? ['coalesce', ['get', 'name:en'], ['get', 'name']]
        : ['coalesce', ['get', `name:${language}`], ['get', 'name:en'], ['get', 'name']]

    map.getStyle().layers.forEach(layer => {
      if (layer.type === 'symbol') {
        const textField = map.getLayoutProperty(layer.id, 'text-field')
        if (textField !== undefined && textField !== null) {
          map.setLayoutProperty(layer.id, 'text-field', expression)
        }
      }
    })
  } catch {
    // Style may not be fully loaded — call after 'style.load' event
  }
}
