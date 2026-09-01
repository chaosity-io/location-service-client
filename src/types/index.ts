// Custom types not provided by AWS SDK

/**
 * At least one of `token`, `getToken` or `refreshToken` must supply a token, or
 * `send` refuses locally with `InvalidCredentialsException` rather than putting
 * `Bearer undefined` on the wire (#37).
 *
 * `token` is optional because a client driven purely by a provider — the shape
 * `@chaosity/location-client-react` uses — has nothing to put there at
 * construction time, and was previously forced to invent a placeholder. It is
 * still required on `ServerClientConfig`, which is a RESULT rather than a
 * configuration: `getClientConfig` always resolves one.
 */
export interface ClientConfig {
  apiUrl: string
  token?: string
  /** Optional callback to get the current token dynamically. When provided,
   *  called on every request so token updates are reflected without recreating the client. */
  getToken?: () => string | undefined
  /**
   * Asked for a replacement AFTER the API has rejected the current token with a
   * 401, so the request can be retried once instead of failing — and, since
   * #37, asked once BEFORE the first send when neither `getToken` nor `token`
   * yields anything, so a client whose token has not arrived yet does not spend
   * a round trip on `Bearer undefined` to learn that. Both calls mean the same
   * thing to an implementor — "give me a usable token" — so a `refreshToken`
   * that mints or awaits one needs no change; only one that assumes every
   * invocation follows a 401 does.
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
