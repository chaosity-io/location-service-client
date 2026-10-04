import { LocationServiceException } from '../errors/LocationServiceException.js'
import { isTokenRejected } from '../transport/errors.js'

/**
 * How long a refusal is remembered: a token the API refused, or a token
 * request `/auth/token` refused (#38).
 *
 * A refusal — a 401 or a 403 — is not something asking again can change. A
 * suspended application is refused on every data route and on `/auth/token`
 * alike, and nothing used to remember that, so every request a busy server
 * served paid for a doomed data request and a doomed token request, all
 * against the application's own token-route throttle.
 *
 * Thirty seconds is short beside the API's own waits: it accepts a
 * reactivated application again within five minutes, and refuses a newly
 * created or reactivated one for up to about thirty seconds while its key goes
 * live. So this side adds at most thirty seconds to either, and turns a
 * request rate into a trickle meanwhile.
 */
export const TOKEN_REFUSAL_HOLD_MS = 30_000

/**
 * A 401 or a 403: the server refused, and a retry gets the same answer.
 *
 * Wider than `isTokenRejected`, which is the 401 a new token can fix. This is
 * about the token SOURCE: `/auth/token` refusing the credentials (401), or
 * the application's key not live on its plan (403), and neither changes by
 * asking again.
 */
export function isTokenRefusal(err: unknown): boolean {
  return (
    err instanceof LocationServiceException &&
    (err.statusCode === 401 || err.statusCode === 403)
  )
}

/**
 * How long `err` says asking again cannot help, in milliseconds; 0 when it
 * says nothing, and the next call may ask at once.
 *
 * Only the server's own word counts: a refusal, or a `Retry-After`. A network
 * fault, a timeout or a 500 carries neither, so it is not remembered, and the
 * next call tries again as it always has — the transport has already retried
 * it with backoff inside the call that failed.
 */
export function holdFor(err: unknown): number {
  if (!(err instanceof LocationServiceException)) return 0
  return Math.max(
    isTokenRefusal(err) ? TOKEN_REFUSAL_HOLD_MS : 0,
    err.retryAfterMs ?? 0,
  )
}

/**
 * One remembered failure, re-thrown instead of asking again until it lapses.
 *
 * Shared by every place that used to ask again on every call: the server
 * `TokenProvider` (a refused or throttled token request), and the two send
 * paths (a token the API refused, and the refresh that could not replace it,
 * or — in `GeoPlacesClient` — could not supply a first one). A send path
 * remembers the failure against the token it concerns, because a DIFFERENT
 * token is a new situation — a background refresh that landed, or a caller's
 * own source that moved on — and ends the hold at once.
 *
 * `askAgain` is the one case where the source may still be asked: the API
 * refused the token, and the refresh that followed failed with nothing to say
 * about when to try again — a network fault, or a rejection that lost its
 * fields crossing a Server Action boundary, as `@chaosity/location-client-react`
 * delivers one. The token is still refused, so it is not sent again; the
 * source is asked on the next send, as it always was.
 */
export class TokenHold {
  private held?: {
    error: LocationServiceException
    until: number
    token?: string
    askAgain: boolean
  }

  /** Remember `err` for as long as it says; a failure that says nothing is not remembered. */
  remember(err: unknown, token?: string, { askAgain = false } = {}): void {
    const ms = holdFor(err)
    if (ms > 0) {
      this.held = {
        error: err as LocationServiceException,
        until: Date.now() + ms,
        token,
        askAgain,
      }
    }
  }

  /**
   * The remembered failure while it stands, as a new exception to throw — for
   * `token`, if one was remembered with it — and whether the source may still
   * be asked. Anything else ends the hold.
   */
  check(
    token?: string,
  ): { error: LocationServiceException; askAgain: boolean } | undefined {
    const held = this.held
    if (!held) return undefined
    const remaining = held.until - Date.now()
    if (remaining <= 0 || (held.token !== undefined && held.token !== token)) {
      this.held = undefined
      return undefined
    }
    const { error, askAgain } = held
    return {
      askAgain,
      error: new LocationServiceException({
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        requestId: error.requestId,
        details: error.details,
        // What is left of a Retry-After, so a caller that schedules on it waits
        // the right amount. A refusal carries none, and gains none here.
        retryAfterMs: error.retryAfterMs === undefined ? undefined : remaining,
        cause: error,
      }),
    }
  }

  forget(): void {
    this.held = undefined
  }
}

/**
 * Send with `token`, and after a 401 once more with `refresh()`'s token when it
 * is a DIFFERENT one, remembering on `hold` what the API and the source said,
 * against the token it concerns (#38).
 *
 * The one copy of the 401 retry: both send paths and the two map fetches (#72)
 * call it, so when to ask again is decided here and nowhere else.
 */
export async function sendRetryingOnce<T>(
  hold: TokenHold,
  token: string,
  send: (token: string) => Promise<T>,
  refresh: () => Promise<string | undefined>,
  onRetry?: () => void,
): Promise<T> {
  // This token was refused a moment ago and nothing has replaced it: answer
  // with that refusal rather than send it, and ask the source again. A
  // different token ends the hold. When the refresh that followed said nothing
  // about when to ask again, it is asked now — but the refused token is still
  // not sent.
  const held = hold.check(token)
  if (held && !held.askAgain) throw held.error

  let rejected: unknown = held?.error
  if (!held) {
    try {
      return await send(token)
    } catch (err) {
      if (!isTokenRejected(err)) throw err
      rejected = err
    }
  }

  // One retry, and only when the replacement is genuinely a different token.
  // That single comparison covers every source: a fixed `token` string, a
  // `getToken` that ignores `forceRefresh`, a `refreshToken` that hands back
  // what it had, and a cached token the API has revoked before its `exp` —
  // re-sending any of them is a second doomed request for the same answer.
  let fresh: string | undefined
  try {
    fresh = await refresh()
  } catch (refusal) {
    // A rotated secret's token route refuses the refresh as the data route
    // refused its token. Without this, every send asked again. A refusal that
    // says nothing — a network fault, or a Server Action's error without its
    // fields — leaves the source to be asked again, but not the token sent.
    if (holdFor(refusal) > 0) hold.remember(refusal, token)
    // Only when no hold stands: one already standing keeps its own end, so
    // the refused token is tried again once per hold rather than never.
    else if (!held) hold.remember(rejected, token, { askAgain: true })
    throw refusal
  }
  if (!fresh || fresh === token) {
    hold.remember(rejected, token)
    throw rejected
  }

  onRetry?.()
  try {
    return await send(fresh)
  } catch (again) {
    if (isTokenRejected(again)) hold.remember(again, fresh)
    throw again
  }
}
