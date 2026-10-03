import debug from 'debug'
import { TokenHold, holdFor } from '../auth/tokenHold.js'
import { resolveEndpoint } from '../transport/endpoints.js'
import { isTokenRejected, noTokenAvailable } from '../transport/errors.js'
import type { RequestOptions } from '../transport/http.js'
import { requestJson } from '../transport/http.js'
import type {
  ClientConfig,
  CommandOutput,
  CommandWithOutput,
  GeoPlacesCommand,
} from '../types/index.js'
import type { AppConfigClaims } from '../utils/tokenClaims.js'
import { readAppConfigClaims } from '../utils/tokenClaims.js'
import type { VerifyAddressResponse } from './commands.js'
import { VerifyAddressCommand } from './commands.js'

const log = debug('location-client:api')

export type SendOptions = RequestOptions

/**
 * What a hold is kept against when there was no token in hand to key it to.
 * `ensureToken` treats an empty token as none, so no real token is this.
 */
const NO_TOKEN = ''

/**
 * GeoPlacesClient — AWS Location Service compatible client with custom auth.
 *
 * Uses AWS SDK command classes but replaces SigV4 with a Bearer token. The
 * request and response types are the AWS SDK's, except that the Places
 * commands take neither `IntendedUse` nor `Key` (#40), and `VerifyAddressCommand`
 * is this package's own (#54).
 *
 * Pass `getToken` in config for live refresh without recreating the client.
 */
export class GeoPlacesClient {
  private clientConfig: ClientConfig
  /** A token the API refused, and why, until the hold lapses (#38). */
  private readonly refused = new TokenHold()
  public readonly config: { serviceId: string }

  constructor(config: ClientConfig) {
    this.clientConfig = config
    this.config = { serviceId: 'Geo Places' }
  }

  /**
   * This application's own configuration, as carried on the access token
   * (api#65): the routes it may call, the domain its requests must come from,
   * and the countries it is scoped to (#40).
   *
   * Provided so an application can SHOW its own settings: populate a country
   * selector with the markets it actually serves, label a settings screen,
   * and so on. Being a few minutes stale is cosmetic for that.
   *
   * It is not an entitlement check. See AppConfigClaims for why acting on
   * any of it client-side makes requests fail that would otherwise succeed.
   *
   * Every token the API issues carries `allowedResources` and `allowedDomain`;
   * `countries` only once a scope is configured in the portal. Returns `{}`
   * for a token carrying none of them.
   */
  getAppConfig(): AppConfigClaims {
    return readAppConfigClaims(this.currentToken())
  }

  /** Prefer the getToken callback (live ref) over a static token string. */
  private currentToken(): string | undefined {
    return this.clientConfig.getToken?.() ?? this.clientConfig.token
  }

  /**
   * A token to send, or a refusal — never `undefined`.
   *
   * `refreshToken` is asked only when there is nothing at all in hand, so a
   * client configured the ordinary way pays nothing for this.
   */
  private async ensureToken(): Promise<string> {
    // Truthiness, not `??`: an empty string is a token source with nothing to
    // give, not a decision to send an empty one. With `??` it survived the
    // coalesce, skipped `refreshToken`, and then failed the check below — so
    // `getToken: () => undefined` got the refresh ask and `getToken: () => ''`
    // did not, which is a distinction no caller means to draw.
    const inHand = this.currentToken()
    if (inHand) return inHand

    // `refreshToken` refused a moment ago, and there is still nothing in hand:
    // answer with that rather than ask it again on every send (#38). The hold
    // is kept against "no token", so one arriving from `getToken` ends it.
    const held = this.refused.check(NO_TOKEN)?.error
    if (held) throw held
    let token: string | undefined
    try {
      token = await this.clientConfig.refreshToken?.()
    } catch (refusal) {
      this.refused.remember(refusal, NO_TOKEN)
      throw refusal
    }
    if (!token) {
      throw noTokenAvailable(
        'the client has no token yet. Pass `token`, or a `getToken`/`refreshToken` that has one.',
      )
    }
    return token
  }

  /**
   * Send a command, and resolve with its output:
   * `await client.send(new AutocompleteCommand(…))` is an
   * `AutocompleteCommandOutput`, with nothing to annotate (#68).
   *
   * @param options `signal` to cancel, `timeoutMs` per attempt,
   *   `overallTimeoutMs` for the whole call, `retry: false` to disable the
   *   retry loop. Every failure throws LocationServiceException.
   */
  send<C extends CommandWithOutput>(
    command: C,
    options?: SendOptions,
  ): Promise<CommandOutput<C>>
  /**
   * The signature `send` had before it inferred its output (#68). It stays
   * so that a call naming both type arguments, and a client typed by a
   * structural `send<TInput, TOutput>` — as `@chaosity/address-form` types
   * its client — still compile.
   */
  send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput>
  async send(command: unknown, options?: SendOptions): Promise<unknown> {
    const cmd = command as GeoPlacesCommand
    const url = `${this.clientConfig.apiUrl}${resolveEndpoint(cmd)}`

    // The fifth and last place in this package that turns a token into an
    // `Authorization` header, and the last one that would send `Bearer
    // undefined` (#37). The 401 self-heal below cannot cover this case — it
    // needs a request to have been rejected first — so a client whose token
    // source has not produced one yet spent a whole round trip to learn
    // something it already knew. Ask the refresh source instead, and refuse if
    // there is still nothing.
    const token = await this.ensureToken()

    // This token was refused a moment ago and nothing has replaced it: answer
    // with that refusal rather than send it, and ask `refreshToken`, again
    // (#38). A different token from `getToken` ends the hold. When the refresh
    // that followed said nothing about when to ask again, it is asked now —
    // but the refused token is still not sent.
    const held = this.refused.check(token)
    if (held && !held.askAgain) throw held.error

    let rejected: unknown = held?.error
    if (!held) {
      try {
        return await this.dispatch(url, token, cmd, options)
      } catch (err) {
        if (!isTokenRejected(err)) throw err
        rejected = err
      }
    }

    // One shot. `refreshToken` is the only way to actually obtain a new token
    // here — `getToken` is synchronous and returns the one already in hand —
    // but it is re-read as a fallback because a provider that refreshes in the
    // background may have landed a new one while this request was in flight.
    let fresh: string | undefined
    try {
      fresh = (await this.clientConfig.refreshToken?.()) ?? this.currentToken()
    } catch (refusal) {
      // A suspended application's token route refuses it as its data routes
      // refuse its token. Without this, every send asked again. A refusal that
      // says nothing — a network fault, or a Server Action's error without its
      // fields — leaves the source to be asked again, but not the token sent.
      if (holdFor(refusal) > 0) this.refused.remember(refusal, token)
      // Only when no hold stands: one already standing keeps its own end, so
      // the refused token is tried again once per hold rather than never.
      else if (!held) this.refused.remember(rejected, token, { askAgain: true })
      throw refusal
    }

    // Nothing new to send. Repeating the request would fail identically — a
    // second round trip for the same 401.
    if (!fresh || fresh === token) {
      this.refused.remember(rejected, token)
      throw rejected
    }

    log('401 — retrying %s once with a refreshed token', cmd.constructor?.name)
    try {
      return await this.dispatch(url, fresh, cmd, options)
    } catch (again) {
      if (isTokenRejected(again)) this.refused.remember(again, fresh)
      throw again
    }
  }

  /**
   * Verify a PlaceId: `send(new VerifyAddressCommand({ PlaceId }))`, typed
   * (#54). Resolves the full place record plus `verified`, and resolves a
   * `verified: false` too — see VerifyAddressResponse for what may be stored.
   *
   * Billed per call, whether or not the address verifies: call it once per
   * chosen PlaceId, at submit, never per keystroke.
   */
  verifyAddress(
    placeId: string,
    options?: SendOptions,
  ): Promise<VerifyAddressResponse> {
    return this.send(new VerifyAddressCommand({ PlaceId: placeId }), options)
  }

  private dispatch(
    url: string,
    token: string,
    cmd: GeoPlacesCommand,
    options?: SendOptions,
  ): Promise<unknown> {
    // The caller's input goes out as the caller wrote it. `BiasPosition` used
    // to be rounded here to a grid sized by a token claim, so nearby callers
    // shared a server cache entry; with no cache the rounding only lowered the
    // precision the upstream geocoder had to work with, which moves the
    // results rather than coarsening them (#51).

    log('Sending %s to %s', cmd.constructor?.name, url)
    return requestJson<unknown>(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(cmd.input),
      },
      options,
    )
  }
}
