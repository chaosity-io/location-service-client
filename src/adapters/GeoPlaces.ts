import {
  GeocodeAdditionalFeature,
  GeocodeCommand,
  type GeocodeCommandInput,
  type GeocodeResponse,
  GetPlaceAdditionalFeature,
  GetPlaceCommand,
  type GetPlaceResponse,
  ReverseGeocodeCommand,
  type ReverseGeocodeResponse,
  SuggestAdditionalFeature,
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
import type { Map } from 'maplibre-gl'
import debug from 'debug'
import { GeoPlacesClient } from '../client/GeoPlacesClient'

const log = debug('location-client:geocoder')

/**
 * GeoPlaces - MapLibre adapter for AWS Location Service
 *
 * Implements MaplibreGeocoderApi interface for compatibility with @maplibre/maplibre-gl-geocoder
 */
export class GeoPlaces implements MaplibreGeocoderApi {
  private client: GeoPlacesClient
  private map: Map

  constructor(client: GeoPlacesClient, map: Map) {
    this.client = client
    this.map = map
  }

  private normalizeLanguage(language?: string | string[]): string {
    if (Array.isArray(language)) return language[0] || 'en'
    if (typeof language === 'string') return language
    return 'en'
  }

  async forwardGeocode(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderFeatureResults> {
    log('forwardGeocode query=%s', config.query)

    const center = this.map.getCenter()
    const biasPosition = config.proximity && config.proximity.length >= 2
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
        IncludeCountries: Array.isArray(config.countries) ? config.countries : config.countries.split(','),
      }
    }

    const response = await this.client.send(new GeocodeCommand(commandInput)) as GeocodeResponse
    const result = geocodeResponseToFeatureCollection(response, { flattenProperties: true }) as MaplibreGeocoderFeatureResults
    log('forwardGeocode returned %d results', result.features?.length ?? 0)
    return result
  }

  async reverseGeocode(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderFeatureResults> {
    log('reverseGeocode query=%o', config.query)

    const queryPosition = Array.isArray(config.query) && config.query.length >= 2
      ? [config.query[0], config.query[1]]
      : [0, 0]

    const commandInput = {
      QueryPosition: queryPosition,
      MaxResults: config.limit || 1,
      Language: this.normalizeLanguage(config.language),
    }

    const response = await this.client.send(new ReverseGeocodeCommand(commandInput)) as ReverseGeocodeResponse
    const result = reverseGeocodeResponseToFeatureCollection(response, { flattenProperties: true }) as MaplibreGeocoderFeatureResults
    log('reverseGeocode returned %d results', result.features?.length ?? 0)
    return result
  }

  async getSuggestions(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderSuggestionResults> {
    log('getSuggestions query=%s', config.query)

    const center = this.map.getCenter()
    const biasPosition = config.proximity && config.proximity.length >= 2
      ? [config.proximity[0], config.proximity[1]]
      : [center.lng, center.lat]

    const commandInput = {
      QueryText: config.query as string,
      BiasPosition: biasPosition,
      MaxResults: config.limit || 5,
      Language: this.normalizeLanguage(config.language),
      AdditionalFeatures: [SuggestAdditionalFeature.CORE],
      ...(config.countries || config.bbox ? {
        Filter: {
          ...(config.countries ? { IncludeCountries: Array.isArray(config.countries) ? config.countries : config.countries.split(',') } : {}),
          ...(config.bbox ? { BoundingBox: config.bbox } : {}),
        },
      } : {}),
    }

    const response = await this.client.send(new SuggestCommand(commandInput)) as SuggestResponse
    const suggestions: MaplibreGeocoderSuggestionResults = { suggestions: [] }

    for (const item of response.ResultItems ?? []) {
      const text = item.Title
      if (!text) continue
      const placeId = item.Place?.PlaceId
      suggestions.suggestions.push({ text, placeId })
    }

    log('getSuggestions returned %d suggestions', suggestions.suggestions.length)
    return suggestions
  }

  async searchByPlaceId(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderPlaceResults> {
    log('searchByPlaceId placeId=%s', config.query)

    const command = new GetPlaceCommand({
      PlaceId: config.query as string,
      Language: this.normalizeLanguage(config.language),
      AdditionalFeatures: [
        GetPlaceAdditionalFeature.ACCESS,
        GetPlaceAdditionalFeature.SECONDARY_ADDRESSES,
        GetPlaceAdditionalFeature.CONTACT,
        GetPlaceAdditionalFeature.TIME_ZONE,
      ],
    })

    const response = await this.client.send(command) as GetPlaceResponse
    const result = getPlaceResponseToFeatureCollection(response, { flattenProperties: true })

    const carmenGeojsonFeatures = result.features.map(feature => ({
      ...feature,
      text: response.Title || '',
      place_name: response.Address?.Label || '',
      place_type: response.PlaceType ? [response.PlaceType] : [],
      bbox: response.MapView as [number, number, number, number] | undefined,
    })) as CarmenGeojsonFeature[]

    log('searchByPlaceId returned %d features', carmenGeojsonFeatures.length)
    return { place: carmenGeojsonFeatures } as MaplibreGeocoderPlaceResults
  }

  async localGeocode(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderFeatureResults> {
    return this.forwardGeocode(config)
  }
}
