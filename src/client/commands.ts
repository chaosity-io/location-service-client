import type {
  GetPlaceResponse,
  AutocompleteCommandInput as SdkAutocompleteCommandInput,
  AutocompleteRequest as SdkAutocompleteRequest,
  GeocodeCommandInput as SdkGeocodeCommandInput,
  GeocodeRequest as SdkGeocodeRequest,
  GetPlaceCommandInput as SdkGetPlaceCommandInput,
  GetPlaceRequest as SdkGetPlaceRequest,
  ReverseGeocodeCommandInput as SdkReverseGeocodeCommandInput,
  ReverseGeocodeRequest as SdkReverseGeocodeRequest,
  SearchNearbyCommandInput as SdkSearchNearbyCommandInput,
  SearchNearbyRequest as SdkSearchNearbyRequest,
  SearchTextCommandInput as SdkSearchTextCommandInput,
  SearchTextRequest as SdkSearchTextRequest,
  SuggestCommandInput as SdkSuggestCommandInput,
  SuggestRequest as SdkSuggestRequest,
} from '@aws-sdk/client-geo-places'
import {
  AutocompleteCommand as SdkAutocompleteCommand,
  GeocodeCommand as SdkGeocodeCommand,
  GetPlaceCommand as SdkGetPlaceCommand,
  ReverseGeocodeCommand as SdkReverseGeocodeCommand,
  SearchNearbyCommand as SdkSearchNearbyCommand,
  SearchTextCommand as SdkSearchTextCommand,
  SuggestCommand as SdkSuggestCommand,
} from '@aws-sdk/client-geo-places'

/**
 * Request fields the Location Service removes from every request (#40).
 *
 * `IntendedUse` chooses the price bucket the service pays, and `Key` is an
 * Amazon Location API key that would bill someone else's account, so neither
 * ever reaches Amazon. The SDK's inputs declare both, and this package used to
 * re-export those commands as they were: `IntendedUse: 'Storage'` compiled,
 * was sent, was stripped, and came back as a result with no storage rights.
 *
 * So the root exports every Places command as a subclass whose constructor
 * takes the input WITHOUT these fields. Narrowing only the input types would
 * not have been enough — the SDK's constructor references the SDK's own type,
 * so `new SearchTextCommand({ IntendedUse })` would still have compiled.
 *
 * Types only. Nothing is removed at runtime: a request body is the caller's
 * input, unchanged, and the service does the stripping. A caller who casts
 * past the type still sends the field and still has it ignored.
 *
 * `test/places-commands.test.ts` reads the command list from the SDK itself,
 * so a command the SDK adds fails there until it is narrowed here.
 */
export type NeverForwarded = 'IntendedUse' | 'Key'

// RICH PLACE DATA (#55). The `AdditionalFeatures` values Access, Contact,
// Phonemes and TimeZone are a feature of the application's plan. On a plan
// without it the request is refused 403 `FeatureNotEntitledException`
// (`isFeatureNotEntitled` on the error), and nothing is returned or billed.
// Each command below that accepts one says which, in a `@planFeature` tag;
// the others — SecondaryAddresses, Intersections, CrossReferences, Core — are
// open to every plan. Which plans include it: https://chaosity.cloud/pricing.

export type AutocompleteRequest = Omit<SdkAutocompleteRequest, NeverForwarded>
export type AutocompleteCommandInput = Omit<
  SdkAutocompleteCommandInput,
  NeverForwarded
>
export class AutocompleteCommand extends SdkAutocompleteCommand {
  constructor(input: AutocompleteCommandInput) {
    super(input)
  }
}

export type GeocodeRequest = Omit<SdkGeocodeRequest, NeverForwarded>
export type GeocodeCommandInput = Omit<SdkGeocodeCommandInput, NeverForwarded>
/**
 * Accepts rich place data, a plan feature: on a plan without it these
 * `AdditionalFeatures` are refused 403 `FeatureNotEntitledException`
 * (`isFeatureNotEntitled` on the error; see `FEATURE_NOT_ENTITLED`).
 *
 * @planFeature rich place data — Access, TimeZone
 */
export class GeocodeCommand extends SdkGeocodeCommand {
  constructor(input: GeocodeCommandInput) {
    super(input)
  }
}

export type GetPlaceRequest = Omit<SdkGetPlaceRequest, NeverForwarded>
export type GetPlaceCommandInput = Omit<SdkGetPlaceCommandInput, NeverForwarded>
/**
 * Accepts rich place data, a plan feature: on a plan without it these
 * `AdditionalFeatures` are refused 403 `FeatureNotEntitledException`
 * (`isFeatureNotEntitled` on the error; see `FEATURE_NOT_ENTITLED`).
 *
 * @planFeature rich place data — Access, Contact, Phonemes, TimeZone
 */
export class GetPlaceCommand extends SdkGetPlaceCommand {
  constructor(input: GetPlaceCommandInput) {
    super(input)
  }
}

export type ReverseGeocodeRequest = Omit<
  SdkReverseGeocodeRequest,
  NeverForwarded
>
export type ReverseGeocodeCommandInput = Omit<
  SdkReverseGeocodeCommandInput,
  NeverForwarded
>
/**
 * Accepts rich place data, a plan feature: on a plan without it these
 * `AdditionalFeatures` are refused 403 `FeatureNotEntitledException`
 * (`isFeatureNotEntitled` on the error; see `FEATURE_NOT_ENTITLED`).
 *
 * @planFeature rich place data — Access, TimeZone
 */
export class ReverseGeocodeCommand extends SdkReverseGeocodeCommand {
  constructor(input: ReverseGeocodeCommandInput) {
    super(input)
  }
}

export type SearchNearbyRequest = Omit<SdkSearchNearbyRequest, NeverForwarded>
export type SearchNearbyCommandInput = Omit<
  SdkSearchNearbyCommandInput,
  NeverForwarded
>
/**
 * Accepts rich place data, a plan feature: on a plan without it these
 * `AdditionalFeatures` are refused 403 `FeatureNotEntitledException`
 * (`isFeatureNotEntitled` on the error; see `FEATURE_NOT_ENTITLED`).
 *
 * @planFeature rich place data — Access, Contact, Phonemes, TimeZone
 */
export class SearchNearbyCommand extends SdkSearchNearbyCommand {
  constructor(input: SearchNearbyCommandInput) {
    super(input)
  }
}

export type SearchTextRequest = Omit<SdkSearchTextRequest, NeverForwarded>
export type SearchTextCommandInput = Omit<
  SdkSearchTextCommandInput,
  NeverForwarded
>
/**
 * Accepts rich place data, a plan feature: on a plan without it these
 * `AdditionalFeatures` are refused 403 `FeatureNotEntitledException`
 * (`isFeatureNotEntitled` on the error; see `FEATURE_NOT_ENTITLED`).
 *
 * @planFeature rich place data — Access, Contact, Phonemes, TimeZone
 */
export class SearchTextCommand extends SdkSearchTextCommand {
  constructor(input: SearchTextCommandInput) {
    super(input)
  }
}

export type SuggestRequest = Omit<SdkSuggestRequest, NeverForwarded>
export type SuggestCommandInput = Omit<SdkSuggestCommandInput, NeverForwarded>
/**
 * Accepts rich place data, a plan feature: on a plan without it these
 * `AdditionalFeatures` are refused 403 `FeatureNotEntitledException`
 * (`isFeatureNotEntitled` on the error; see `FEATURE_NOT_ENTITLED`).
 *
 * @planFeature rich place data — Access, Phonemes, TimeZone
 */
export class SuggestCommand extends SdkSuggestCommand {
  constructor(input: SuggestCommandInput) {
    super(input)
  }
}

/**
 * A PlaceId, and nothing else: the service forwards `PlaceId` alone to this
 * route, so `Language`, `PoliticalView` and `AdditionalFeatures` would be
 * dropped rather than honoured. The type refuses them instead (#54).
 */
export interface VerifyAddressCommandInput {
  /**
   * From an autocomplete, suggestion, geocode or place result — including a
   * unit's, from a place's `SecondaryAddresses`.
   */
  PlaceId: string
}

/**
 * The answer to a verify: the record `GetPlaceCommand` returns — the
 * building's units in `SecondaryAddresses` included, `$metadata` not — plus
 * `verified`.
 *
 * `verified` is true for a `PointAddress`, or a `SecondaryAddress` (a unit),
 * and false for anything else: an interpolated address, a street, a locality,
 * a point of interest. A `false` is still a 200 and still billed, so it
 * resolves; it never throws.
 *
 * This is the one Places result an integrator may store, except a place in
 * Japan, which may not be stored at all. Every other Places result is for
 * display.
 *
 * Keep the PlaceId you sent beside it. The answer's own `PlaceId` can differ,
 * and for a unit it does: the service fails that one on every Places route,
 * while the one you sent verifies again.
 */
export type VerifyAddressResponse = Omit<GetPlaceResponse, 'PricingBucket'> & {
  /**
   * The bucket the stored record belongs to (`Stored`), not what this call
   * was billed at. Every verify is billed on its own meter, whether the
   * service answered it from its store or not.
   */
  PricingBucket: string | undefined
  /** `PointAddress` or `SecondaryAddress`: the address is verified. */
  verified: boolean
}

/**
 * `POST /address/verify` (#54): resolve one PlaceId to the full place record
 * plus `verified`. `GeoPlacesClient.verifyAddress` and
 * `LocationServiceConnector.verifyAddress` send this.
 *
 * Billed per call, whether or not the address verifies. Send it once per
 * chosen PlaceId — at submit — never per keystroke. A repeat verify of the
 * same PlaceId may be answered from the service's own store, and is billed
 * all the same.
 *
 * Not an SDK command: the route has none. It extends nothing on purpose —
 * `ENDPOINTS` matches by `instanceof`, so a subclass of `GetPlaceCommand`
 * would match that entry and go to `/address/place`.
 */
export class VerifyAddressCommand {
  readonly input: VerifyAddressCommandInput

  constructor(input: VerifyAddressCommandInput) {
    this.input = input
  }
}
