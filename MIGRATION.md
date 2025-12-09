# Migration Guide

## Changes in Latest Version

### Return Type Changed to GeoJSON FeatureCollection

All adapter methods now return standard GeoJSON `FeatureCollection` instead of custom `{ features: Feature[] }`.

#### Before:
```typescript
const result = await geoPlaces.forwardGeocode({ query: 'Vancouver' })
result.features.forEach(feature => {
  console.log(feature.place_name)
})
```

#### After:
```typescript
const featureCollection = await geoPlaces.forwardGeocode({ query: 'Vancouver' })
featureCollection.features.forEach(feature => {
  console.log(feature.properties.place_name)
})
```

### Benefits:

1. **Standard GeoJSON** - Compatible with all mapping libraries
2. **AWS Utilities** - Uses `placeToFeatureCollection` from AWS
3. **Flattened Properties** - `flattenProperties: true` makes properties easier to access
4. **Type Safety** - Uses GeoJSON types from `geojson` package

### Property Access:

With `flattenProperties: true`, AWS response properties are flattened:

```typescript
// Properties are flattened for easy access
feature.properties.Title
feature.properties.PlaceId
feature.properties.Position
feature.properties.Address_Label
```
