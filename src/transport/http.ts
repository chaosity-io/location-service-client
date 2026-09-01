import debug from 'debug'
import { LocationServiceException } from '../errors/LocationServiceException.js'
import { parseErrorResponse, parseRetryAfter } from './errors.js'

const log = debug('location-client:transport')

/** Per-attempt timeout. Sits well under the API's own 25 s Lambda ceiling. */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Ceiling for the WHOLE call — every attempt plus every wait between them.
 *
 * `timeoutMs` bounds an attempt, not a call, and the gap between those two is
 * where the caller's own deadline disappears. The API answers a spent quota
 * with `Retry-After: 60`, which the retry loop honoured literally: two waits of
 * a minute each, so one call could sit for ~120 s — past any Lambda budget,
 * past any HTTP gateway, and until now uncancellable (#37).
 *
 * 30 s is picked to sit just under the old worst case: three default attempts
 * that all time out, plus their backoff, came to ~30.75 s. The overlap is not
 * quite nothing — when both earlier attempts burn their full 10 s, the third is
 * clamped to the ~9.25 s that remain, so a response arriving in its final
 * ~0.75 s used to succeed and now times out. That window is why this ships in a
 * MINOR rather than a patch. What it buys is that no call can be made to sit
 * out a retry hint longer than the caller has.
 */
export const DEFAULT_OVERALL_TIMEOUT_MS = 30_000

export const DEFAULT_MAX_ATTEMPTS = 3

const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 4_000

export interface RequestOptions {
  /** Caller cancellation. Aborting rejects with code `AbortedException`. */
  signal?: AbortSignal
  /** Per ATTEMPT, not for the whole call. Default 10 s. */
  timeoutMs?: number
  /**
   * The whole call — attempts and the waits between them. Default 30 s.
   *
   * No attempt is given more than what is left of it, and a retry that would
   * have to wait longer than what is left is not made at all: the API's own
   * error comes back instead, `retryAfterMs` intact, so the caller can decide
   * whether to queue the work or drop it.
   */
  overallTimeoutMs?: number
  /** `false` disables retries entirely. Default 3 attempts = 2 retries. */
  retry?: false | { maxAttempts?: number }
}

/**
 * Combine the caller's signal with a per-attempt timeout.
 *
 * `AbortSignal.any` is the clean way and exists in Node 20+ and current
 * browsers; the manual fan-in keeps older runtimes working rather than
 * throwing at import time.
 */
function attemptSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!caller) return { signal: timeout, cleanup: () => {} }

  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([caller, timeout]), cleanup: () => {} }
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  if (caller.aborted || timeout.aborted) controller.abort()
  caller.addEventListener('abort', abort)
  timeout.addEventListener('abort', abort)
  return {
    signal: controller.signal,
    cleanup: () => {
      caller.removeEventListener('abort', abort)
      timeout.removeEventListener('abort', abort)
    },
  }
}

/** Exponential backoff with FULL jitter, so retries never march in lockstep. */
export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

/**
 * Sleep, unless the caller aborts first.
 *
 * The timer used to be uncancellable, so an `abort()` during backoff was
 * ignored until it elapsed — up to a whole `Retry-After` — and the loop only
 * noticed at the top of the next attempt (#37). Resolving early is all that is
 * needed: the loop's own pre-attempt check is what raises `AbortedException`,
 * so exactly one place decides what an abort means.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Turns an OK response into the caller's value. */
type ReadBody<T> = (response: Response) => Promise<T>

/**
 * One request, with timeout, cancellation and retry.
 *
 * The body is read INSIDE the attempt loop deliberately: a truncated or
 * malformed body is a failed attempt like any other and earns the same
 * wrapping and the same retry as a dropped socket. Handing the `Response` back
 * for the caller to read would move that outside the loop, where a bare
 * `SyntaxError` escapes as itself.
 */
async function request<T>(
  url: string,
  init: RequestInit,
  options: RequestOptions,
  read: ReadBody<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const overallTimeoutMs =
    options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS
  const maxAttempts =
    options.retry === false
      ? 1
      : (options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)

  // A request budget of zero attempts is a caller mistake, not a policy. It
  // used to fall straight through the loop and raise `InternalException` for a
  // request that was never made — an error about our own internals, for their
  // typo (#37).
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new LocationServiceException({
      code: 'ValidationException',
      message: `retry.maxAttempts must be a whole number of at least 1; received ${maxAttempts}`,
      details: { source: 'client' },
    })
  }

  const deadline = Date.now() + overallTimeoutMs
  let lastError: LocationServiceException | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Checked before every attempt: a signal aborted during backoff must not fire one more.
    if (options.signal?.aborted) throw abortedException(options.signal)

    const budget = deadline - Date.now()
    if (budget <= 0)
      throw lastError ?? overallTimeoutException(overallTimeoutMs)

    // Never longer than what is left of the call, so the per-attempt timeout
    // cannot overrun the budget it sits inside.
    const { signal, cleanup } = attemptSignal(
      options.signal,
      Math.min(timeoutMs, budget),
    )
    try {
      const response = await fetch(url, { ...init, signal })

      if (response.ok) return await read(response)

      const error = parseErrorResponse(
        response.status,
        response.statusText,
        await response.text(),
        response.headers,
      )
      lastError = error
      if (!error.isRetryable || attempt === maxAttempts - 1) throw error

      const wait =
        error.retryAfterMs ??
        parseRetryAfter(response.headers.get('retry-after')) ??
        backoffMs(attempt)

      // Sitting out a 60 s `Retry-After` inside a 30 s budget only delivers the
      // same failure after the caller has already given up. Stop now and hand
      // back what the API said, `retryAfterMs` and all.
      if (wait >= deadline - Date.now()) {
        log('not retrying: a %d ms wait outlasts the remaining budget', wait)
        break
      }

      log('attempt %d failed (%s), retrying', attempt + 1, error.code)
      await sleep(wait, options.signal)
    } catch (err) {
      if (err instanceof LocationServiceException) {
        // Already classified above, or thrown on the final attempt.
        if (!err.isRetryable || attempt === maxAttempts - 1) throw err
        lastError = err
        continue
      }
      const wrapped = wrapFetchError(err, options.signal)
      lastError = wrapped
      if (!wrapped.isRetryable || attempt === maxAttempts - 1) throw wrapped

      const wait = backoffMs(attempt)
      if (wait >= deadline - Date.now()) {
        log('not retrying: a %d ms wait outlasts the remaining budget', wait)
        break
      }

      log('attempt %d failed (%s), retrying', attempt + 1, wrapped.code)
      await sleep(wait, options.signal)
    } finally {
      cleanup()
    }
  }

  // Reached when the budget ran out before another attempt could be made, so
  // `lastError` is the API's own answer and is the useful thing to throw.
  throw (
    lastError ??
    new LocationServiceException({
      code: 'InternalException',
      message: 'Request failed',
    })
  )
}

/**
 * One JSON request, with timeout, cancellation and retry.
 *
 * Every failure leaves as a LocationServiceException — a fetch rejection
 * becomes `NetworkException` with the original as `cause`, an abort becomes
 * `AbortedException`, a timeout becomes `TimeoutException` with
 * `details.source = 'client'` so it is distinguishable from the API's own 504.
 */
export function requestJson<T>(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<T> {
  return request<T>(
    url,
    init,
    options,
    (response) => response.json() as Promise<T>,
  )
}

/**
 * One request answered as a Blob — the static map path.
 *
 * Exists so the two map fetches are not the only calls in the package without
 * a timeout, a retry or a signal: they used their own bare `fetch`, so a
 * network fault there escaped as a raw `TypeError` while the identical fault on
 * any other call arrived as `NetworkException` (#37).
 */
export function requestBlob(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<Blob> {
  return request(url, init, options, (response) => response.blob())
}

function abortedException(signal?: AbortSignal): LocationServiceException {
  return new LocationServiceException({
    code: 'AbortedException',
    message: 'Request was aborted by the caller',
    details: { source: 'client' },
    cause: signal?.reason,
  })
}

/** The call's own budget elapsed, rather than one attempt's timeout. */
function overallTimeoutException(
  overallTimeoutMs: number,
): LocationServiceException {
  return new LocationServiceException({
    code: 'TimeoutException',
    message: `Request exceeded its overall timeout of ${overallTimeoutMs} ms`,
    details: { source: 'client' },
  })
}

/**
 * fetch rejects with a raw `TypeError` for a network fault and a `DOMException`
 * named AbortError for both cancellation and timeout — indistinguishable from
 * each other unless the caller's own signal is checked, which is why that is
 * checked first.
 */
function wrapFetchError(
  err: unknown,
  callerSignal?: AbortSignal,
): LocationServiceException {
  const name = (err as { name?: string } | undefined)?.name

  if (callerSignal?.aborted) return abortedException(callerSignal)

  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LocationServiceException({
      code: 'TimeoutException',
      message: 'Request timed out',
      details: { source: 'client' },
      cause: err,
    })
  }

  return new LocationServiceException({
    code: 'NetworkException',
    message: err instanceof Error ? err.message : 'Network request failed',
    details: { source: 'client' },
    cause: err,
  })
}
