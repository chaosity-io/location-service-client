import debug from 'debug'
import { LocationServiceException } from '../errors/LocationServiceException'
import { parseErrorResponse, parseRetryAfter } from './errors'

const log = debug('location-client:transport')

/** Per-attempt timeout. Sits well under the API's own 25 s Lambda ceiling. */
export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_ATTEMPTS = 3

const BACKOFF_BASE_MS = 250
const BACKOFF_CAP_MS = 4_000

export interface RequestOptions {
  /** Caller cancellation. Aborting rejects with code `AbortedException`. */
  signal?: AbortSignal
  /** Per ATTEMPT, not for the whole call. Default 10 s. */
  timeoutMs?: number
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One JSON request, with timeout, cancellation and retry.
 *
 * Every failure leaves as a LocationServiceException — a fetch rejection
 * becomes `NetworkException` with the original as `cause`, an abort becomes
 * `AbortedException`, a timeout becomes `TimeoutException` with
 * `details.source = 'client'` so it is distinguishable from the API's own 504.
 */
export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxAttempts =
    options.retry === false
      ? 1
      : (options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)

  let lastError: LocationServiceException | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Checked before every attempt: a signal aborted during backoff must not fire one more.
    if (options.signal?.aborted) throw abortedException(options.signal)

    const { signal, cleanup } = attemptSignal(options.signal, timeoutMs)
    try {
      const response = await fetch(url, { ...init, signal })

      if (response.ok) return (await response.json()) as T

      const error = parseErrorResponse(
        response.status,
        response.statusText,
        await response.text(),
        response.headers,
      )
      lastError = error
      if (!error.isRetryable || attempt === maxAttempts - 1) throw error
      log('attempt %d failed (%s), retrying', attempt + 1, error.code)
      await sleep(
        error.retryAfterMs ??
          parseRetryAfter(response.headers.get('retry-after')) ??
          backoffMs(attempt),
      )
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
      log('attempt %d failed (%s), retrying', attempt + 1, wrapped.code)
      await sleep(backoffMs(attempt))
    } finally {
      cleanup()
    }
  }

  /* c8 ignore next */
  throw (
    lastError ??
    new LocationServiceException({
      code: 'InternalException',
      message: 'Request failed',
    })
  )
}

function abortedException(signal?: AbortSignal): LocationServiceException {
  return new LocationServiceException({
    code: 'AbortedException',
    message: 'Request was aborted by the caller',
    details: { source: 'client' },
    cause: signal?.reason,
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
