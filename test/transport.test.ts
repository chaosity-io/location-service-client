import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOKEN_REFRESH_BUFFER_SECONDS,
  readTokenExpiry,
} from '../src/auth/tokenRefresh'
import { LocationServiceException } from '../src/errors/LocationServiceException'
import { parseErrorResponse, parseRetryAfter } from '../src/transport/errors'
import { backoffMs, requestJson } from '../src/transport/http'

/**
 * The transport contract from RFC-0002: one error type, a per-attempt timeout,
 * cancellation, and retry ONLY on the statuses that can succeed on a second try.
 *
 * None of this existed before: a stalled connection hung the caller forever, a
 * 429 was thrown straight at them with `Retry-After` discarded, and a network
 * fault surfaced as a raw TypeError.
 */

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const call = (opts = {}) =>
  requestJson<{ ok: boolean }>('https://api.test/x', { method: 'POST' }, opts)

describe('retry policy', () => {
  it('retries a 503 and returns the eventual success', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ error: 'temporarily_unavailable' }, { status: 503 }),
      )
      .mockResolvedValueOnce(json({ ok: true }))

    await expect(call()).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 400 — a bad request stays bad', async () => {
    fetchMock.mockResolvedValue(
      json({ message: 'bad', code: 'ValidationException' }, { status: 400 }),
    )

    await expect(call()).rejects.toMatchObject({ code: 'ValidationException' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 500 — the server broke on this request and will again', async () => {
    fetchMock.mockResolvedValue(json({ message: 'boom' }, { status: 500 }))

    await expect(call()).rejects.toMatchObject({ code: 'InternalException' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts and throws the last error', async () => {
    // mockImplementation, not mockResolvedValue: a Response body can be read
    // only once, and each retry must get a fresh one — as it does from a real fetch.
    fetchMock.mockImplementation(async () =>
      json({ message: 'nope' }, { status: 503 }),
    )

    await expect(call({ retry: { maxAttempts: 3 } })).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('honours retry: false', async () => {
    fetchMock.mockResolvedValue(json({ message: 'nope' }, { status: 503 }))

    await expect(call({ retry: false })).rejects.toBeInstanceOf(
      LocationServiceException,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a network failure, which arrives as a raw TypeError', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ ok: true }))

    await expect(call()).resolves.toEqual({ ok: true })
  })
})

describe('the call has a budget, not just each attempt (#37)', () => {
  /**
   * `timeoutMs` bounds an attempt; nothing bounded the CALL. The API answers a
   * spent quota with `Retry-After: 60`, which the loop honoured literally — two
   * waits of a minute inside a request that had seconds to live.
   */
  const throttled = (retryAfter: string) =>
    json(
      { message: 'quota exceeded', code: 'ThrottlingException' },
      { status: 429, headers: { 'retry-after': retryAfter } },
    )

  it('does not sit out a Retry-After longer than the call has left', async () => {
    fetchMock.mockImplementation(async () => throttled('60'))

    const err = await call().catch((e) => e)

    // One attempt, and the answer comes back now rather than in two minutes.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(err.code).toBe('ThrottlingException')
    expect(err.statusCode).toBe(429)
    // The hint survives, so the caller can queue the work instead of guessing.
    expect(err.retryAfterMs).toBe(60_000)
  })

  it('still honours a Retry-After that fits inside the budget', async () => {
    fetchMock
      .mockResolvedValueOnce(throttled('0'))
      .mockResolvedValueOnce(json({ ok: true }))

    await expect(call()).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives an attempt no more time than the call has left', async () => {
    // A 3 s per-attempt timeout inside a 100 ms budget is a 100 ms attempt.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
          )
        }),
    )

    const started = Date.now()
    const err = await call({
      timeoutMs: 3_000,
      overallTimeoutMs: 100,
      retry: false,
    }).catch((e) => e)

    expect(err.code).toBe('TimeoutException')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('refuses a call with no budget at all before sending anything', async () => {
    const err = await call({ overallTimeoutMs: 0 }).catch((e) => e)

    expect(err.code).toBe('TimeoutException')
    expect(err.details).toEqual({ source: 'client' })
    expect(err.message).toContain('overall timeout')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours abort() DURING the wait between attempts', async () => {
    // The backoff timer used to be uncancellable, so an abort here was ignored
    // until the wait elapsed — up to a whole Retry-After.
    fetchMock.mockImplementation(async () => throttled('2'))

    const controller = new AbortController()
    const started = Date.now()
    const pending = call({ signal: controller.signal })

    // Let the first attempt fail and the wait actually begin.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    controller.abort()

    const err = await pending.catch((e) => e)
    expect(err.code).toBe('AbortedException')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('rejects a retry budget of zero instead of blaming its own internals', async () => {
    // `maxAttempts: 0` fell straight through the loop and raised
    // `InternalException` for a request that was never made.
    const err = await call({ retry: { maxAttempts: 0 } }).catch((e) => e)

    expect(err.code).toBe('ValidationException')
    expect(err.message).toContain('maxAttempts')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('one error type for everything', () => {
  it('wraps a network fault as NetworkException, keeping the cause', async () => {
    const original = new TypeError('fetch failed')
    fetchMock.mockRejectedValue(original)

    const err = await call({ retry: false }).catch((e) => e)
    expect(err).toBeInstanceOf(LocationServiceException)
    expect(err.code).toBe('NetworkException')
    expect(err.details).toEqual({ source: 'client' })
    expect(err.cause).toBe(original)
  })

  it('reports caller cancellation as AbortedException, not a DOMException', async () => {
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockResolvedValue(json({ ok: true }))

    const err = await call({ signal: controller.signal }).catch((e) => e)
    expect(err.code).toBe('AbortedException')
    expect(err.isRetryable).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks a client-side timeout so it is distinguishable from the API 504', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    )

    const err = await call({ retry: false }).catch((e) => e)
    expect(err.code).toBe('TimeoutException')
    expect(err.details).toEqual({ source: 'client' })
    expect(err.statusCode).toBeUndefined()
  })
})

describe('error envelope parsing (legacy tolerance)', () => {
  it('reads the service Lambda shape', () => {
    const e = parseErrorResponse(
      400,
      'Bad Request',
      JSON.stringify({
        message: 'bad field',
        code: 'ValidationException',
        requestId: 'r-1',
      }),
    )
    expect(e).toMatchObject({
      message: 'bad field',
      code: 'ValidationException',
      requestId: 'r-1',
    })
  })

  it('reads the OAuth shape from /auth/token and maps the 503', () => {
    const e = parseErrorResponse(
      503,
      'Service Unavailable',
      JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: 'Authentication store unavailable',
      }),
    )
    expect(e.code).toBe('ServiceUnavailableException')
    expect(e.message).toBe('Authentication store unavailable')
    expect(e.isRetryable).toBe(true)
    expect(e.isAuth).toBe(false)
  })

  it('synthesises a code for a bare gateway body', () => {
    const e = parseErrorResponse(
      401,
      'Unauthorized',
      JSON.stringify({ message: 'Unauthorized' }),
    )
    expect(e.code).toBe('UnauthorizedException')
    expect(e.isAuth).toBe(true)
    expect(e.isRetryable).toBe(false)
  })

  it('survives a non-JSON body', () => {
    const e = parseErrorResponse(502, 'Bad Gateway', '<html>nope</html>')
    expect(e.code).toBe('UpstreamException')
    expect(e.message).toContain('nope')
  })
})

describe('Retry-After', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000)
  })

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 2000).toUTCString()
    expect(parseRetryAfter(future)).toBeGreaterThan(0)
  })

  it('ignores nonsense', () => {
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe('backoff', () => {
  it('is bounded and jittered, so retries never march in lockstep', () => {
    expect(backoffMs(0, () => 1)).toBe(250)
    expect(backoffMs(1, () => 1)).toBe(500)
    expect(backoffMs(10, () => 1)).toBe(4000) // capped
    expect(backoffMs(3, () => 0)).toBe(0) // full jitter can pick zero
  })
})

describe('token refresh policy is one number, and expiry comes from the token', () => {
  /**
   * The server provider and the React provider used to carry separate `60`s —
   * a private literal in `isExpired()` and a public prop default — with nothing
   * tying them together. When they disagreed, the client asked for a token
   * fresher than the server would mint, got the same one back, and asked again
   * immediately: ~110 requests per second from an idle page on 2026-08-23.
   */
  it('exposes one buffer for both sides to share', () => {
    expect(TOKEN_REFRESH_BUFFER_SECONDS).toBe(60)
  })

  it('reads the expiry out of the token rather than being told it', () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ exp }))}.sig`
    expect(readTokenExpiry(token)).toBe(exp * 1000)
  })

  it('returns undefined for anything unparseable, so callers keep a fallback', () => {
    expect(readTokenExpiry(undefined)).toBeUndefined()
    expect(readTokenExpiry('not-a-jwt')).toBeUndefined()
    expect(readTokenExpiry('a.b.c')).toBeUndefined()
    expect(readTokenExpiry(`x.${btoa('{"no":"exp"}')}.y`)).toBeUndefined()
  })
})
