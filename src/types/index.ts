// Custom types not provided by AWS SDK

export interface ClientConfig {
  apiUrl: string
  token: string
  /** Optional callback to get the current token dynamically. When provided,
   *  called on every request so token updates are reflected without recreating the client. */
  getToken?: () => string | undefined
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
