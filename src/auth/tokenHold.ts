import { LocationServiceException } from '../errors/LocationServiceException.js'

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
 * Thirty seconds bounds how long an application that has just been made
 * active again waits for this side to notice: long enough to turn a request
 * rate into a trickle, short enough to be a pause rather than an outage. It is
 * also about how long a newly created application is refused while it goes
 * live, which is the one refusal that clears itself.
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
