import {
  LocationServiceException,
  type LocationServiceErrorCode,
} from '../errors/LocationServiceException.js'

/**
 * Turn a non-2xx response into a LocationServiceException.
 *
 * The API answers every failure with a `code`, in one of three envelopes:
 *
 *   { message, code, requestId }                    data routes; the gateway
 *   { error, error_description, code, requestId }   /auth/token (OAuth 2.0)
 *   { code, message }                               the per-address limit
 *
 * The sentence is in `message`, or on /auth/token in `error_description`, and
 * both are read whatever else the body carries (#38). The description used to
 * be read only from a body with no `code`, and /auth/token has sent one since,
 * so every refusal from it arrived as "Request failed: Unauthorized": a
 * suspended application read exactly like a wrong secret.
 *
 * A body with no `code` — a proxy's, or an older deployment's — still gets
 * one: from its OAuth `error`, else from the status.
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
    const text = (value: unknown) =>
      typeof value === 'string' ? value : undefined

    message =
      text(data.error_description) ??
      text(data.message) ??
      text(data.error) ??
      message
    code = text(data.code)
    requestId = text(data.requestId)

    // OAuth `error`, from /auth/token and the gateway's 401 on it
    const oauthError = text(data.error)
    if (oauthError) {
      code ??= oauthCode(oauthError, status)
      details = { oauthError }
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
function oauthCode(error: string, status: number): LocationServiceErrorCode {
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
function statusCode(status: number): LocationServiceErrorCode {
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
