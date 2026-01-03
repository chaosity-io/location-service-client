import { GeocodeAdditionalFeature, GeocodeCommand, GeocodeCommandInput, GeocodeFilterPlaceType, GeocodeResponse, GetPlaceAdditionalFeature, GetPlaceCommand, ReverseGeocodeCommand, SuggestAdditionalFeature, SuggestCommand, SuggestResponse, type GetPlaceResponse, type ReverseGeocodeResponse } from '@aws-sdk/client-geo-places'
import { geocodeResponseToFeatureCollection, getPlaceResponseToFeatureCollection, reverseGeocodeResponseToFeatureCollection, suggestResponseToFeatureCollection } from '@aws/amazon-location-utilities-datatypes'
import type { CarmenGeojsonFeature, MaplibreGeocoderApi, MaplibreGeocoderApiConfig, MaplibreGeocoderFeatureResults, MaplibreGeocoderPlaceResults, MaplibreGeocoderSuggestionResults } from '@maplibre/maplibre-gl-geocoder'
import type { Map } from 'maplibre-gl'
import { GeoPlacesClient } from '../client/GeoPlacesClient'

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
    console.log('[GeoPlaces] forwardGeocode called with:', config)

    const center = this.map.getCenter()
    const biasPosition = config.proximity && config.proximity.length >= 2
      ? [config.proximity[0], config.proximity[1]]
      : [center.lng, center.lat]

    const commandInput: any = {
      QueryText: config.query as string,
      BiasPosition: biasPosition,
      MaxResults: config.limit || 5,
      Language: this.normalizeLanguage(config.language),
    }

    if (config.countries || config.bbox) {
      commandInput.Filter = {}
      if (config.countries) commandInput.Filter.IncludeCountries = config.countries
      if (config.bbox) commandInput.Filter.BoundingBox = config.bbox
    }

    console.log('[GeoPlaces] Sending SearchTextCommand with:', commandInput)
    const command = new GeocodeCommand(commandInput)
    const response = await this.client.send(command) as GeocodeResponse
    console.log('[GeoPlaces] SearchTextCommand response:', response)

    const result = geocodeResponseToFeatureCollection(response, { flattenProperties: true }) as MaplibreGeocoderFeatureResults
    console.log('[GeoPlaces] Converted to FeatureCollection:', result)
    return result
  }

  async reverseGeocode(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderFeatureResults> {
    console.log('[GeoPlaces] reverseGeocode called with:', config)

    const queryPosition = Array.isArray(config.query) && config.query.length >= 2
      ? [config.query[0], config.query[1]]
      : [0, 0]

    const commandInput: any = {
      QueryPosition: queryPosition,
      MaxResults: config.limit || 1,
      Language: this.normalizeLanguage(config.language)
    }

    if (config.countries) {
      commandInput.Filter = { IncludeCountries: config.countries }
    }

    const command = new ReverseGeocodeCommand(commandInput)
    const response = await this.client.send(command) as ReverseGeocodeResponse
    const maplibreGeocoderFeatureResults: MaplibreGeocoderFeatureResults = reverseGeocodeResponseToFeatureCollection(response, { flattenProperties: true }) as MaplibreGeocoderFeatureResults
    maplibreGeocoderFeatureResults.features.forEach(feature => {

    })
    console.log('[GeoPlaces] Converted to FeatureCollection:', maplibreGeocoderFeatureResults)
    return maplibreGeocoderFeatureResults


  }

  async getSuggestions(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderSuggestionResults> {


    // const center = this.map.getCenter()
    // const biasPosition = config.proximity && config.proximity.length >= 2
    //   ? [config.proximity[0], config.proximity[1]]
    //   : [center.lng, center.lat]

    // const commandInput: any = {
    //   QueryText: config.query as string,
    //   BiasPosition: biasPosition,
    //   MaxResults: config.limit || 5,
    //   Language: this.normalizeLanguage(config.language),
    //   AdditionalFeatures: [SuggestAdditionalFeature.CORE],
    // }

    // if (config.countries || config.bbox) {
    //   commandInput.Filter = {}
    //   if (config.countries) commandInput.Filter.IncludeCountries = config.countries
    //   if (config.bbox) commandInput.Filter.BoundingBox = config.bbox
    // }


    // const command = new SuggestCommand(commandInput)
    // const response = await this.client.send(command) as SuggestResponse

    const center = this.map.getCenter()
    const biasPosition = config.proximity && config.proximity.length >= 2
      ? [config.proximity[0], config.proximity[1]]
      : [center.lng, center.lat]

    const commandInput: GeocodeCommandInput = {
      QueryText: config.query as string,
      BiasPosition: biasPosition,
      MaxResults: config.limit || 5,
      Language: this.normalizeLanguage(config.language),
      AdditionalFeatures: [GeocodeAdditionalFeature.SECONDARY_ADDRESSES],
    }

    if (config.countries || config.bbox) {
      commandInput.Filter = {}
      if (config.countries) commandInput.Filter.IncludeCountries = Array.isArray(config.countries) ? config.countries : config.countries.split(',')
      // if (config.types) commandInput.Filter.IncludePlaceTypes = config.types.split(',').map(type => new GeocodeFilterPlaceType)
    }

    console.log('[GeoPlaces] Sending SearchTextCommand with:', commandInput)
    const command = new GeocodeCommand(commandInput)
    const response = await this.client.send(command) as GeocodeResponse
    console.log('[GeoPlaces] SearchTextCommand response:', response)


    const maplibreGeocoderSuggestionResults: MaplibreGeocoderSuggestionResults = { suggestions: [] };
    response?.ResultItems?.forEach(item => {
      const text = item?.Title || item?.Address?.Label;
      const placeId = item?.PlaceId;
      if (text) {
        maplibreGeocoderSuggestionResults.suggestions.push({
          text,
          placeId,
        });
      }
    });

    console.log('[GeoPlaces] Converted to MaplibreGeocoderSuggestionResults:', maplibreGeocoderSuggestionResults);

    return maplibreGeocoderSuggestionResults
  }

  async searchByPlaceId(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderPlaceResults> {
    console.log('[GeoPlaces] searchByPlaceId called with:', config)
    const placeId = config.query as string
    const command = new GetPlaceCommand({
      PlaceId: placeId,
      Language: this.normalizeLanguage(config.language),
      AdditionalFeatures: [GetPlaceAdditionalFeature.ACCESS, GetPlaceAdditionalFeature.SECONDARY_ADDRESSES, GetPlaceAdditionalFeature.CONTACT, GetPlaceAdditionalFeature.TIME_ZONE],
    })

    const response = await this.client.send(command) as GetPlaceResponse
    const result = getPlaceResponseToFeatureCollection(response, { flattenProperties: true })
    console.log('[GeoPlaces] GetPlaceCommand response converted to FeatureCollection:', result)

    const carmenGeojsonFeatures = result.features.map(feature => ({
      ...feature,
      text: response.Title || '',
      place_name: response.Address?.Label || '',
      place_type: response.PlaceType ? [response.PlaceType] : [],
      bbox: response.MapView as [number, number, number, number] | undefined
    })) as CarmenGeojsonFeature[]

    console.log('[GeoPlaces] Converted to CarmenGeojsonFeatures:', carmenGeojsonFeatures)
    return { place: carmenGeojsonFeatures } as MaplibreGeocoderPlaceResults
  }

  async localGeocode(config: MaplibreGeocoderApiConfig): Promise<MaplibreGeocoderFeatureResults> {
    console.log('[GeoPlaces] localGeocode called with:', config)
    return this.forwardGeocode(config)
  }
}
