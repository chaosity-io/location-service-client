import type { RequestTransformFunction } from 'maplibre-gl'

/**
 * Creates a transformRequest function for MapLibre that adds authentication
 * and proper Accept headers for AWS Location Service API requests.
 *
 * @param apiUrl - Base URL of the Location Service API
 * @param getToken - Callback function that returns the current auth token
 * @returns MapLibre transformRequest function
 */
export function createTransformRequest(
  apiUrl: string,
  getToken: () => string | undefined,
): RequestTransformFunction {
  return (url: string, resourceType?: string) => {
    if (url.startsWith(apiUrl)) {
      const token = getToken()
      if (!token) {
        console.warn('[createTransformRequest] No token available')
        return { url }
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      }

      // Set appropriate Accept headers based on resource type
      if (url.includes('/tiles/')) {
        headers['Accept'] = 'application/x-protobuf'
      } else if (url.includes('/glyphs/')) {
        headers['Accept'] = 'application/x-protobuf'
      } else if (url.includes('/sprites/') && url.endsWith('.png')) {
        headers['Accept'] = 'image/png'
      } else if (url.includes('/sprites/') && url.endsWith('.json')) {
        headers['Accept'] = 'application/json'
      } else if (url.includes('/descriptor')) {
        headers['Accept'] = 'application/json'
      }

      return { url, headers }
    }
    return { url }
  }
}
