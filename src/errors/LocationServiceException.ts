/**
 * The code of a 403 for an option the application's plan does not include
 * (#55): a map feature such as `satellite` or `terrain`, or rich place data.
 * The options that can earn it are tagged `@planFeature` in their
 * documentation.
 *
 * The service refuses before calling upstream, so the refusal is not billed,
 * and its message names each refused feature and the option that asked for
 * it. It never names a plan: which plan includes which feature can change
 * without a release of this package — see https://chaosity.cloud/pricing.
 * Nothing in the token lists the features either, so this 403 is the first a
 * caller hears of it; there is no check to make beforehand.
 */
export const FEATURE_NOT_ENTITLED = 'FeatureNotEntitledException'

/**
 * Every `code` the API sends (#38): its error contract, published at
 * https://docs.chaosity.cloud/api/errors, plus the Amazon Location exception
 * names it passes through from upstream.
 *
 * A few are worth knowing apart. `RateLimitExceededException` is the
 * application's own throttle; `ThrottlingException` is Amazon Location
 * throttling the service; `IpRateLimitExceededException` is the per-address
 * limit in front of `/auth/token`. `ApplicationNotActiveException` (403) is an
 * application that is new, suspended or off its plan.
 * `TokenExpiredException` is in the contract but never sent: an expired token
 * arrives as `UnauthorizedException`.
 */
export const API_ERROR_CODES = [
  'AccessDeniedException',
  'ApplicationNotActiveException',
  'ClientException',
  'FeatureNotEntitledException',
  'ForbiddenException',
  'InternalException',
  'InternalServerException',
  'InvalidCredentialsException',
  'IpRateLimitExceededException',
  'NotAcceptableException',
  'NotFoundException',
  'OriginNotAllowedException',
  'RateLimitExceededException',
  'ResourceNotFoundException',
  'ServiceUnavailableException',
  'ThrottlingException',
  'TimeoutException',
  'TokenExpiredException',
  'UnauthorizedException',
  'UpstreamException',
  'ValidationException',
] as const

/**
 * The codes only this package raises, for failures that never reached the
 * API. It raises some of the API's codes too — `TimeoutException` for its own
 * timeout, `InvalidCredentialsException` for a missing token — and those are
 * in the list above.
 */
export const CLIENT_ERROR_CODES = [
  'AbortedException',
  'NetworkException',
  'ServiceException',
  'UnknownCommandException',
] as const

export const LOCATION_SERVICE_ERROR_CODES = [
  ...API_ERROR_CODES,
  ...CLIENT_ERROR_CODES,
] as const

/**
 * A `LocationServiceException`'s `code`: one of these, or a code the API adds
 * after this release, which arrives all the same.
 */
export type LocationServiceErrorCode =
  (typeof LOCATION_SERVICE_ERROR_CODES)[number]

export interface LocationServiceExceptionOptions {
  message: string
  code: LocationServiceErrorCode | (string & {})
  /** Absent for failures that never reached the server: network, timeout, abort. */
  statusCode?: number
  requestId?: string
  /** Structured extras — `source: 'client'` marks a locally-raised failure. */
  details?: Record<string, unknown>
  cause?: unknown
  /** Parsed from the `Retry-After` header, in milliseconds. */
  retryAfterMs?: number
}

/**
 * The single error type this package throws.
 *
 * Every failure — an API error envelope, a network fault, a timeout, an abort —
 * arrives as one of these, so a caller writes one `catch` and asks the getters
 * rather than sniffing at `TypeError` vs `DOMException` vs a bare `Error`.
 */
export class LocationServiceException extends Error {
  /** See `LocationServiceErrorCode`: typed, and open to a code added later. */
  readonly code: LocationServiceErrorCode | (string & {})
  readonly statusCode?: number
  readonly requestId?: string
  readonly details?: Record<string, unknown>
  readonly retryAfterMs?: number

  constructor(options: LocationServiceExceptionOptions) {
    super(options.message, { cause: options.cause })
    this.name = 'LocationServiceException'
    this.code = options.code
    this.statusCode = options.statusCode
    this.requestId = options.requestId
    this.details = options.details
    this.retryAfterMs = options.retryAfterMs
  }

  /**
   * Worth another attempt.
   *
   * Deliberately a explicit list rather than `statusCode >= 500`: a 500 or 501
   * means the server broke on this request and will break again, while 502/503/
   * 504 mean it never got there or gave up waiting. Retrying the first kind just
   * multiplies the damage. Network failures and timeouts are retryable because
   * nothing was necessarily processed.
   */
  get isRetryable(): boolean {
    if (this.code === 'AbortedException') return false
    if (this.code === 'NetworkException' || this.code === 'TimeoutException')
      return true
    return (
      this.statusCode === 429 || [502, 503, 504].includes(this.statusCode ?? 0)
    )
  }

  get isThrottling(): boolean {
    return this.code === 'ThrottlingException' || this.statusCode === 429
  }

  get isValidation(): boolean {
    return this.code === 'ValidationException' || this.statusCode === 400
  }

  /**
   * Any 401 or 403 — the caller must act, and retrying will not help.
   *
   * That is several failures with different remedies: bad or expired
   * credentials, an `Origin` the application does not allow, a route its plan
   * does not include, an option its plan does not include. Branch on `code`,
   * or on `isFeatureNotEntitled` for the last, to tell them apart.
   */
  get isAuth(): boolean {
    return this.statusCode === 401 || this.statusCode === 403
  }

  /**
   * The application's plan does not include an option this request asked for
   * (`FEATURE_NOT_ENTITLED`). The message names the feature; drop the option,
   * or move the application to a plan that includes it.
   */
  get isFeatureNotEntitled(): boolean {
    return this.code === FEATURE_NOT_ENTITLED
  }

  get isAborted(): boolean {
    return this.code === 'AbortedException'
  }

  get isTimeout(): boolean {
    return this.code === 'TimeoutException'
  }

  toString(): string {
    const parts = [`LocationServiceException: [${this.code}] ${this.message}`]
    if (this.requestId) parts.push(`(requestId: ${this.requestId})`)
    return parts.join(' ')
  }
}
