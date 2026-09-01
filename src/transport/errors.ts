import { LocationServiceException } from '../errors/LocationServiceException.js'

/**
 * Turn a non-2xx response into a LocationServiceException.
 *
 * The API does not yet speak one error shape — that is api#29 (T23) — so this
 * tolerates the three it currently emits and synthesises a `code` for each.
 * RFC-0002 calls this legacy tolerance, and it is what lets the client ship
 * before the API contract lands. Delete the fallbacks once T23 is deployed.
 *
 *   { message, code, requestId }         service Lambdas — already correct
 *   { error, error_description }         /auth/token, OAuth shape
 *   { message: "Unauthorized" }          API Gateway's own responses
 */
export function parseErrorResponse(
  status: number,
  statusText: string,
  body: string,
  headers?: Headers,
): LocationServiceException {
  let message = `Request failed: ${statusText || status}`
  let code: string | undefined
  let requestId: string | undefined
  let details: Record<string, unknown> | undefined

  try {
    const data = JSON.parse(body)

    if (typeof data.message === 'string') message = data.message
    if (typeof data.code === 'string') code = data.code
    if (typeof data.requestId === 'string') requestId = data.requestId

    // OAuth envelope from /auth/token
    if (!code && typeof data.error === 'string') {
      message = data.error_description ?? data.error
      code = oauthCode(data.error, status)
      details = { oauthError: data.error }
    }
  } catch {
    if (body) message = body
  }

  return new LocationServiceException({
    message,
    code: code ?? statusCode(status),
    statusCode: status,
    requestId,
    details,
    retryAfterMs: parseRetryAfter(headers?.get('retry-after')),
  })
}

/** OAuth `error` values the token endpoint emits, mapped to our codes. */
function oauthCode(error: string, status: number): string {
  switch (error) {
    case 'temporarily_unavailable':
      return 'ServiceUnavailableException'
    case 'invalid_client':
    case 'unauthorized':
      return 'InvalidCredentialsException'
    case 'invalid_request':
      return 'ValidationException'
    case 'unsupported_grant_type':
      return 'ValidationException'
    default:
      return statusCode(status)
  }
}

/** Last resort when the body carried no code at all (bare gateway responses). */
function statusCode(status: number): string {
  switch (status) {
    case 400:
      return 'ValidationException'
    case 401:
      return 'UnauthorizedException'
    case 403:
      return 'ForbiddenException'
    case 404:
      return 'NotFoundException'
    case 429:
      return 'ThrottlingException'
    case 502:
      return 'UpstreamException'
    case 503:
      return 'ServiceUnavailableException'
    case 504:
      return 'TimeoutException'
    default:
      return status >= 500 ? 'InternalException' : 'ServiceException'
  }
}

/**
 * The API has rejected this token: a 401, and only a 401.
 *
 * The authorizer throws `Unauthorized` for a token it cannot verify or that has
 * expired, and API Gateway turns that into a 401. Its other refusals — no
 * domain configured for the application, an Origin the application does not
 * allow — are a Deny policy or a service 403, and a fresh token changes
 * neither. Retrying those sends the same doomed request twice, for the same
 * answer — which is the whole cost, since the service meters successful
 * requests and no error response is billed whatever its status.
 *
 * Shared by both send paths so the browser client and the server connector
 * cannot come to different conclusions about the same response.
 */
export function isTokenRejected(err: unknown): boolean {
  return err instanceof LocationServiceException && err.statusCode === 401
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Both are legal and the
 * API sends the first; a date is handled so a proxy or gateway cannot surprise us.
 */
export function parseRetryAfter(
  value: string | null | undefined,
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * No token to send, so nothing is sent.
 *
 * Every send path resolves a token before it builds a request, and every one of
 * them can come up empty — a provider that has not initialised, a server action
 * that returned nothing, credentials that are not configured. Sending anyway
 * puts the literal string `Bearer undefined` on the wire, which the API answers
 * with a 401 the caller then has to work backwards from — a whole round trip,
 * paid for out of the caller's own deadline, to be told what it already knew.
 * The map fetches did exactly that until #37.
 *
 * `advice` says what to check, because that differs by path: a server connector
 * wants its client credentials looked at, a browser map wants its token source.
 */
export function noTokenAvailable(advice: string): LocationServiceException {
  return new LocationServiceException({
    code: 'InvalidCredentialsException',
    message: `No token available — ${advice}`,
    details: { source: 'client' },
  })
}
