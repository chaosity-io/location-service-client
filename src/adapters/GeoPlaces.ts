import { placeToFeatureCollection } from '@aws/amazon-location-utilities-datatypes'
import type { FeatureCollection } from 'geojson'
import type { Map } from 'maplibre-gl'
import { GeoPlacesClient } from '../client/GeoPlacesClient'


import { GetPlaceCommand, GetPlaceResponse, ReverseGeocodeCommand, SearchNearbyCommand, SuggestCommand } from '@aws-sdk/client-geo-places'
/**
 * GeoPlaces - MapLibre adapter for AWS Location Service
 * 
 * Uses AWS Location Client commands and utilities for data conversion.
 * Only auth is custom (Bearer token instead of SigV4).
 */
export class GeoPlaces {
  private client: GeoPlacesClient
  private map: Map

  constructor(client: GeoPlacesClient, map: Map) {
    this.client = client
    this.map = map
  }

  async forwardGeocode(config: { query: string; limit?: number }): Promise<FeatureCollection> {
    const center = this.map.getCenter()
    const command = new SuggestCommand({
      QueryText: config.query,
      BiasPosition: [center.lng, center.lat],
      MaxResults: config.limit || 5,
      Language: 'en'
    })

    const response = await this.client.send(command) as any
    return placeToFeatureCollection(response, { flattenProperties: true })
  }

  async reverseGeocode(config: { query: [number, number]; limit?: number; click?: boolean }): Promise<FeatureCollection> {
    const command = config.click
      ? new ReverseGeocodeCommand({
        QueryPosition: config.query,
        MaxResults: config.limit || 1,
        Language: 'en'
      })
      : new SearchNearbyCommand({
        QueryPosition: config.query,
        MaxResults: config.limit || 15,
        Language: 'en'
      })

    const response = await this.client.send(command) as any
    return placeToFeatureCollection(response, { flattenProperties: true })
  }

  async getSuggestions(config: { query: string }): Promise<FeatureCollection> {
    const center = this.map.getCenter()
    const command = new SuggestCommand({
      QueryText: config.query,
      BiasPosition: [center.lng, center.lat],
      Language: 'en'
    })

    const response = await this.client.send(command) as any
    return placeToFeatureCollection(response, { flattenProperties: true })
  }

  async searchByPlaceId(placeId: string): Promise<FeatureCollection> {
    const command = new GetPlaceCommand({
      PlaceId: placeId,
      Language: 'en'
    })

    const response = await this.client.send(command) as any
    return placeToFeatureCollection(response, { flattenProperties: true })
  }
}
