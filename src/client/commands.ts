import type {
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
export class GeocodeCommand extends SdkGeocodeCommand {
  constructor(input: GeocodeCommandInput) {
    super(input)
  }
}

export type GetPlaceRequest = Omit<SdkGetPlaceRequest, NeverForwarded>
export type GetPlaceCommandInput = Omit<SdkGetPlaceCommandInput, NeverForwarded>
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
export class SearchTextCommand extends SdkSearchTextCommand {
  constructor(input: SearchTextCommandInput) {
    super(input)
  }
}

export type SuggestRequest = Omit<SdkSuggestRequest, NeverForwarded>
export type SuggestCommandInput = Omit<SdkSuggestCommandInput, NeverForwarded>
export class SuggestCommand extends SdkSuggestCommand {
  constructor(input: SuggestCommandInput) {
    super(input)
  }
}
