import { noTokenAvailable } from '../transport/errors.js'
import type { RequestOptions } from '../transport/http.js'
import { requestBlob } from '../transport/http.js'
import type {
  ColorScheme,
  LabelSize,
  MapFeatureMode,
  ScaleBarUnit,
  StaticMapStyle,
} from './mapEnums.js'

/**
 * Static maps: build the URL, send the right headers, get a Blob.
 *
 * This exists because `/maps/static/{fileName}` is the one map route MapLibre
 * never requests, so `createTransformRequest` never sees it and every caller was
 * left to hand-roll the fetch. Ours did — `nextjs-address-finder-full`'s
 * NearbySearch.tsx carried a comment explaining the rule — which is the clearest
 * sign it belonged in the library (client#25, api#35).
 *
 * Two things make a plain fetch fail, and neither is discoverable:
 *
 * 1. `Accept` MUST name the exact type. Measured against the sandbox on
 *    2026-08-26: `image/png` -> 200, while `image/*`, `*\/*`, and the header a
 *    browser sends for `<img>` all -> 406. Not even `image/*` is enough.
 *
 * 2. The type follows the STYLE, not the file name, and the default is
 *    Satellite:
 *
 *      Standard   -> image/png
 *      Satellite  -> image/jpeg   <- the default when `style` is omitted
 *
 *    So the naive `Accept: image/png` is wrong for the DEFAULT request. The API
 *    hit the mirror image of this bug itself: it hard-coded image/png on the
 *    response and labelled every default render — a JPEG — as a PNG.
 *
 * `<img src="...">` cannot be made to work: it sends neither `Authorization` nor
 * an acceptable `Accept`. Fetching to a Blob is the only viable shape, which is
 * why this returns one rather than a URL.
 */

/** `map`, or `map@2x` for a retina render. There is no file extension. */
export type StaticMapFileName = 'map' | 'map@2x'

export interface StaticMapOptions {
  /** Pixels, 64-1500. */
  width: number
  /** Pixels, 64-1500. */
  height: number

  // Exactly ONE of the three below is required. The API rejects zero or more
  // than one with a message naming which were given.

  /** `[longitude, latitude]`. */
  center?: [number, number]
  /** `[west, south, east, north]`. */
  boundingBox?: [number, number, number, number]
  /** Positions the render must contain, as `[lng, lat]` pairs. */
  boundedPositions?: Array<[number, number]>

  zoom?: number
  radius?: number
  padding?: number
  cropLabels?: boolean
  style?: StaticMapStyle
  colorScheme?: ColorScheme
  labelSize?: LabelSize
  /**
   * `Enabled` | `Disabled` -- NOT a list of categories. api#35 records this
   * being passed as a string array against the SDK's Enabled|Disabled type,
   * working only by stringification. Typed here so that cannot recur.
   */
  pointsOfInterests?: MapFeatureMode
  scaleBarUnit?: ScaleBarUnit
  /** Defaults to `map`. */
  fileName?: StaticMapFileName
}

/**
 * The Accept header this request must send.
 *
 * Exported because it is the one rule a caller cannot guess, and anyone doing
 * their own fetch — a server-side render, a proxy — needs it too. Satellite is
 * the default, so an absent style means JPEG.
 */
export function staticMapAccept(style?: StaticMapStyle): string {
  return style === 'Standard' ? 'image/png' : 'image/jpeg'
}

/** A coordinate as the API accepts it: at most six decimals, no float noise. */
const coord = (n: number): string => String(Number(n.toFixed(6)))

/** Build the request URL without fetching it. */
export function buildStaticMapUrl(
  apiUrl: string,
  options: StaticMapOptions,
): string {
  const {
    width,
    height,
    center,
    boundingBox,
    boundedPositions,
    fileName = 'map',
    ...rest
  } = options

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
  })

  // Positions go over the wire as comma-separated numbers. api#35 records that
  // passing arrays straight through worked only by accidental stringification;
  // doing it explicitly here means the shape is ours, not JavaScript's default.
  //
  // Each number is rounded to six decimals (#29). The API caps a coordinate at
  // fourteen decimals, and a value straight from `map.getCenter()` routinely
  // has fifteen or sixteen — so the obvious "render what the user is looking
  // at" was a 400 blaming the FORMAT. Six decimals is ~10 cm, more than a
  // raster render can show.
  if (center) params.set('center', center.map(coord).join(','))
  if (boundingBox) params.set('bounding-box', boundingBox.map(coord).join(','))
  if (boundedPositions) {
    params.set(
      'bounded-positions',
      boundedPositions.flat().map(coord).join(','),
    )
  }

  // The API accepts kebab-case on the wire and camelCase for older callers;
  // kebab is the documented form, so emit that.
  const KEBAB: Record<string, string> = { cropLabels: 'crop-labels' }
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue
    params.set(KEBAB[key] ?? key, String(value))
  }

  return `${apiUrl}/maps/static/${fileName}?${params}`
}

/**
 * Fetch a static map as a Blob.
 *
 * @param apiUrl   Base URL of the Location Service API
 * @param options  Render options; exactly one of center / boundingBox / boundedPositions
 * @param getToken Callback returning the current auth token
 * @param request  Transport options: `signal` to cancel, `timeoutMs`, `overallTimeoutMs`, `retry`
 *
 * @example
 * const blob = await fetchStaticMap(API_URL, {
 *   width: 640, height: 400, center: [151.2093, -33.8688], zoom: 14,
 *   style: 'Standard',
 * }, getToken)
 * const url = URL.createObjectURL(blob)   // remember to revokeObjectURL
 */
export async function fetchStaticMap(
  apiUrl: string,
  options: StaticMapOptions,
  getToken: () => string | undefined,
  request: RequestOptions = {},
): Promise<Blob> {
  const token = getToken()
  // The same guard as fetchMapStyle and the server connector: a render is not
  // worth requesting without a token to send (#37).
  if (!token) {
    throw noTokenAvailable(
      'getToken() returned nothing, so no static map was requested. Check the token provider has finished initialising.',
    )
  }

  // Through the shared transport, so a static map gets the timeout, budget,
  // cancellation and retry every other call has -- and its failures arrive as
  // LocationServiceException rather than as a raw TypeError. The API's own
  // {message, code, requestId} survives, which matters here: the messages are
  // specific and actionable -- "'width' and 'height' are required", "Only one
  // of center, bounding-box or bounded-positions may be set".
  return requestBlob(
    buildStaticMapUrl(apiUrl, options),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: staticMapAccept(options.style),
      },
    },
    request,
  )
}
