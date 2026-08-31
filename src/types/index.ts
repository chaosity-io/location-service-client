// Custom types not provided by AWS SDK

export interface ClientConfig {
  apiUrl: string
  token: string
  /** Optional callback to get the current token dynamically. When provided,
   *  called on every request so token updates are reflected without recreating the client. */
  getToken?: () => string | undefined
  /**
   * Asked for a replacement AFTER the API has rejected the current token with a
   * 401, so the request can be retried once instead of failing.
   *
   * Separate from `getToken` because that one is synchronous by contract — it
   * is read while a request is being built and cannot await anything, so it can
   * only ever return the token already in hand. Nothing in this library could
   * therefore recover from a token revoked, or a secret rotated, before its
   * `exp`: every request failed until the refresh buffer elapsed on its own
   * (#36).
   *
   * Returning `undefined` is not "no replacement": the client then re-reads
   * `getToken`, because a provider refreshing in the background may have landed
   * a new token while the failed request was in flight. What actually decides
   * is the token that comes out of those two — if it is the one just rejected,
   * or there is none, the retry is skipped rather than repeating a request that
   * is going to fail again.
   */
  refreshToken?: () => Promise<string | undefined>
}

/**
 * Minimal interface for AWS SDK command objects.
 * All AWS SDK commands (AutocompleteCommand, SearchTextCommand, etc.) extend
 * Smithy's Command base class which has an `input` property containing the
 * request parameters. This interface captures what we actually need from
 * commands without coupling to Smithy internals.
 */
export interface GeoPlacesCommand {
  readonly input: object
}

/**
 * Minimal interface for a MapLibre Map instance.
 * Using a structural type avoids hard coupling to a specific maplibre-gl version.
 */
export interface MapLike {
  isStyleLoaded(): boolean | void
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
  getStyle(): { layers: Array<{ id: string; type: string }> }
  getLayoutProperty(layerId: string, name: string): unknown
  setLayoutProperty(layerId: string, name: string, value: unknown): void
}
