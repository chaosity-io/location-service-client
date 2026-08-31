import {
  GeocodeCommand,
  type GeocodeCommandInput,
  type GeocodeResponse,
  GetPlaceAdditionalFeature,
  GetPlaceCommand,
  type GetPlaceResponse,
  ReverseGeocodeCommand,
  type ReverseGeocodeResponse,
  SuggestCommand,
  type SuggestResponse,
} from '@aws-sdk/client-geo-places'
import {
  geocodeResponseToFeatureCollection,
  getPlaceResponseToFeatureCollection,
  reverseGeocodeResponseToFeatureCollection,
} from '@aws/amazon-location-utilities-datatypes'
import type {
  CarmenGeojsonFeature,
  MaplibreGeocoderApi,
  MaplibreGeocoderApiConfig,
  MaplibreGeocoderFeatureResults,
  MaplibreGeocoderPlaceResults,
  MaplibreGeocoderSuggestionResults,
} from '@maplibre/maplibre-gl-geocoder'
import debug from 'debug'
import type { Map } from 'maplibre-gl'
import type { GeoPlacesClient } from '../client/GeoPlacesClient.js'

const log = debug('location-client:geocoder')

/**
 * GeoPlaces - MapLibre adapter for AWS Location Service
 *
 * Implements MaplibreGeocoderApi interface for compatibility with @maplibre/maplibre-gl-geocoder
 */
/**
 * Extra GetPlace detail, and what each one costs (#3 / T19).
 *
 * Measured against Amazon Location on 2026-08-25 by requesting each feature
 * alone and reading the pricing bucket back:
 *
 *   (none)              -> Core      $0.50/1k
 *   SecondaryAddresses  -> Core      $0.50/1k
 *   Access              -> Advanced  $1.50/1k
 *   TimeZone            -> Advanced  $1.50/1k
 *   Contact             -> Advanced  $1.50/1k
 *
 * `secondaryAddresses` is therefore free in bucket terms and the others triple
 * the price of every lookup. They are opt-in for that reason, not because the
 * data is unwelcome.
 *
 * Worth knowing before enabling `contact`: for a street address it costs
 * Advanced and returns no contact field at all — only points of interest carry
 * one. On an address-completion flow that is 3x the price for nothing.
 */
export interface GeoPlacesDetailOptions {
  /** Entrance/exit points. Moves the request to the Advanced bucket. */
  access?: boolean
  /** Unit and sub-address detail. Stays in the Core bucket — free to enable. */
  secondaryAddresses?: boolean
  /** Phone/website, POIs only. Moves the request to the Advanced bucket. */
  contact?: boolean
  /** IANA zone and offset. Moves the request to the Advanced bucket. */
  timeZone?: boolean
}

export interface GeoPlacesOptions {
  /**
   * Extra detail on `searchByPlaceId`. Default: none, which keeps every
   * lookup in the Core bucket.
   */
  details?: GeoPlacesDetailOptions
}

type ConvertedFeature = ReturnType<
  typeof geocodeResponseToFeatureCollection
>['features'][number]

/**
 * Give the control the fields it renders, not just the ones GeoJSON needs.
 *
 * `@maplibre/maplibre-gl-geocoder` is a Carmen-shaped consumer: its result list
 * calls `item.place_name.split(',')`, the input takes `result.place_name` on
 * select, and fly-to reads `center` / `bbox`. The AWS converters produce plain
 * GeoJSON — `properties` and `geometry` only — so a forward geocode used to
 * hand the control features with no `place_name`. The list renderer threw, the
 * control caught it and emitted `error`, and with no listener that surfaced as
 * `Unhandled error. (undefined)` in the console: the Enter key silently did
 * nothing. Suggestions were unaffected because that path renders `text`.
 *
 * The `as MaplibreGeocoderFeatureResults` cast this replaces is what hid it —
 * `place_name` and `text` are required on the type.
 */
function toCarmenFeatures(
  features: ConvertedFeature[],
): CarmenGeojsonFeature[] {
  return features.map((feature) => {
    const p = (feature.properties ?? {}) as Record<string, unknown>
    const title = typeof p.Title === 'string' ? p.Title : ''
    const label =
      typeof p['Address.Label'] === 'string' ? p['Address.Label'] : ''
    // `flattenProperties` flattens nested OBJECTS (Address.Label) but leaves an
    // array of numbers intact, so MapView is still [minx, miny, maxx, maxy].
    const view = p.MapView
    const bbox =
      Array.isArray(view) &&
      view.length === 4 &&
      view.every((v) => typeof v === 'number')
        ? (view as [number, number, number, number])
        : undefined
    const center =
      feature.geometry?.type === 'Point'
        ? (feature.geometry.coordinates as [number, number])
        : undefined
    return {
      ...feature,
      text: title || label,
      place_name: label || title,
      place_type: typeof p.PlaceType === 'string' ? [p.PlaceType] : [],
      ...(bbox ? { bbox } : {}),
      ...(center ? { center } : {}),
    } as CarmenGeojsonFeature
  })
}

export class GeoPlaces implements MaplibreGeocoderApi {
  private client: GeoPlacesClient
  private map: Map
  private details: GeoPlacesDetailOptions

  constructor(
    client: GeoPlacesClient,
    map: Map,
    options: GeoPlacesOptions = {},
  ) {
    this.client = client
    this.map = map
    this.details = options.details ?? {}
  }

  /**
   * Build the AdditionalFeatures list from the opt-ins, or omit it entirely.
   *
   * Returning `undefined` rather than `[]` matters: an empty array is still a
   * field on the request, and the point is to send nothing.
   */
  private detailFeatures(): GetPlaceAdditionalFeature[] | undefined {
    const features: GetPlaceAdditionalFeature[] = []
    if (this.details.access) features.push(GetPlaceAdditionalFeature.ACCESS)
    if (this.details.secondaryAddresses)
      features.push(GetPlaceAdditionalFeature.SECONDARY_ADDRESSES)
    if (this.details.contact) features.push(GetPlaceAdditionalFeature.CONTACT)
    if (this.details.timeZone)
      features.push(GetPlaceAdditionalFeature.TIME_ZONE)
    return features.length ? features : undefined
  }

  private normalizeLanguage(language?: string | string[]): string {
    if (Array.isArray(language)) return language[0] || 'en'
    if (typeof language === 'string') return language
    return 'en'
  }

  async forwardGeocode(
    config: MaplibreGeocoderApiConfig,
  ): Promise<MaplibreGeocoderFeatureResults> {
    log('forwardGeocode query=%s', config.query)

    const center = this.map.getCenter()
    const biasPosition =
      config.proximity && config.proximity.length >= 2
        ? [config.proximity[0], config.proximity[1]]
        : [center.lng, center.lat]

    const commandInput: GeocodeCommandInput = {
      QueryText: config.query as string,
      BiasPosition: biasPosition,
      MaxResults: config.limit || 5,
      Language: this.normalizeLanguage(config.language),
    }

    if (config.countries) {
      commandInput.Filter = {
        IncludeCountries: Array.isArray(config.countries)
          ? config.countries
          : config.countries.split(','),
      }
    }

    const response = (await this.client.send(
      new GeocodeCommand(commandInput),
    )) as GeocodeResponse
    const converted = geocodeResponseToFeatureCollection(response, {
      flattenProperties: true,
    })
    const result: MaplibreGeocoderFeatureResults = {
      type: 'FeatureCollection',
      features: toCarmenFeatures(converted.features),
    }
    log('forwardGeocode returned %d results', result.features.length)
    return result
  }

  async reverseGeocode(
    config: MaplibreGeocoderApiConfig,
  ): Promise<MaplibreGeocoderFeatureResults> {
    log('reverseGeocode query=%o', config.query)

    const queryPosition =
      Array.isArray(config.query) && config.query.length >= 2
        ? [config.query[0], config.query[1]]
        : [0, 0]

    const commandInput = {
      QueryPosition: queryPosition,
      MaxResults: config.limit || 1,
      Language: this.normalizeLanguage(config.language),
    }

    const response = (await this.client.send(
      new ReverseGeocodeCommand(commandInput),
    )) as ReverseGeocodeResponse
    const converted = reverseGeocodeResponseToFeatureCollection(response, {
      flattenProperties: true,
    })
    const result: MaplibreGeocoderFeatureResults = {
      type: 'FeatureCollection',
      features: toCarmenFeatures(converted.features),
    }
    log('reverseGeocode returned %d results', result.features.length)
    return result
  }

  async getSuggestions(
    config: MaplibreGeocoderApiConfig,
  ): Promise<MaplibreGeocoderSuggestionResults> {
    log('getSuggestions query=%s', config.query)

    const center = this.map.getCenter()
    const biasPosition =
      config.proximity && config.proximity.length >= 2
        ? [config.proximity[0], config.proximity[1]]
        : [center.lng, center.lat]

    const commandInput = {
      QueryText: config.query as string,
      BiasPosition: biasPosition,
      MaxResults: config.limit || 5,
      Language: this.normalizeLanguage(config.language),
      // No AdditionalFeatures (#3 / T19).
      //
      // This used to send `[Core]`, which put every keystroke in the Core
      // bucket at $0.50/1k. The only thing Core adds to a Suggest response is
      // `Highlights`, and this adapter reads `Title` and `Place.PlaceId` —
      // nothing else. Verified against Amazon Location on 2026-08-25:
      //
      //   with [Core] -> bucket Core   keys: Title, ..., Place, Highlights
      //   without     -> bucket Label  keys: Title, ..., Place
      //
      // Same two fields, $0.20/1k instead of $0.50. Suggest fires per
      // keystroke, so it is the highest-volume call the library makes.
      ...(config.countries || config.bbox
        ? {
            Filter: {
              ...(config.countries
                ? {
                    IncludeCountries: Array.isArray(config.countries)
                      ? config.countries
                      : config.countries.split(','),
                  }
                : {}),
              ...(config.bbox ? { BoundingBox: config.bbox } : {}),
            },
          }
        : {}),
    }

    const response = (await this.client.send(
      new SuggestCommand(commandInput),
    )) as SuggestResponse
    const suggestions: MaplibreGeocoderSuggestionResults = { suggestions: [] }

    for (const item of response.ResultItems ?? []) {
      const text = item.Title
      if (!text) continue
      const placeId = item.Place?.PlaceId
      suggestions.suggestions.push({ text, placeId })
    }

    log(
      'getSuggestions returned %d suggestions',
      suggestions.suggestions.length,
    )
    return suggestions
  }

  async searchByPlaceId(
    config: MaplibreGeocoderApiConfig,
  ): Promise<MaplibreGeocoderPlaceResults> {
    log('searchByPlaceId placeId=%s', config.query)

    // Opt-in rather than always-on (#3 / T19). Requesting all four put every
    // lookup in the Advanced bucket at $1.50/1k; the default now sends none
    // and stays in Core at $0.50. Callers that want the detail ask for it.
    const additionalFeatures = this.detailFeatures()
    const command = new GetPlaceCommand({
      PlaceId: config.query as string,
      Language: this.normalizeLanguage(config.language),
      ...(additionalFeatures ? { AdditionalFeatures: additionalFeatures } : {}),
    })

    const response = (await this.client.send(command)) as GetPlaceResponse
    const result = getPlaceResponseToFeatureCollection(response, {
      flattenProperties: true,
    })

    const carmenGeojsonFeatures = result.features.map((feature) => ({
      ...feature,
      text: response.Title || '',
      place_name: response.Address?.Label || '',
      place_type: response.PlaceType ? [response.PlaceType] : [],
      bbox: response.MapView as [number, number, number, number] | undefined,
    })) as CarmenGeojsonFeature[]

    log('searchByPlaceId returned %d features', carmenGeojsonFeatures.length)
    return { place: carmenGeojsonFeatures } as MaplibreGeocoderPlaceResults
  }

  async localGeocode(
    config: MaplibreGeocoderApiConfig,
  ): Promise<MaplibreGeocoderFeatureResults> {
    return this.forwardGeocode(config)
  }
}
