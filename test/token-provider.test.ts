import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenProvider } from '../src/auth/TokenProvider'
import { TOKEN_REFUSAL_HOLD_MS } from '../src/auth/tokenHold'
import { LocationServiceException } from '../src/errors/LocationServiceException'

/**
 * TokenProvider was at 0% coverage — 181 lines, and the highest-consequence
 * code in the library (#6 / T35).
 *
 * It owns three properties that fail silently when they break:
 *
 *   1. A refusal REJECTS rather than resolving `{ success: false }`, so a stale
 *      token can never be used by accident.
 *   2. Transient failure is separated from terminal. `503 temporarily_unavailable`
 *      — what the API returns when its config store is unreachable — must not
 *      look like `401 unauthorized`, or a customer whose credentials are fine is
 *      told to go and check them (#9, and api#10 at the other end).
 *   3. Concurrent callers share one in-flight fetch, and a FAILED fetch does not
 *      poison the next attempt.
 *
 * The suite stubs `globalThis.fetch` and returns real `Response` objects, the
 * same shape test/transport.test.ts uses, so the real retry loop, error parsing
 * and caching all execute.
 *
 * A `Response` body can only be read ONCE, so any test expecting more than one
 * fetch uses `mockImplementation` to build a fresh one per call. Reusing a
 * single object fails as "Body has already been read" from inside the
 * transport, which reads like a client bug and is not one.
 */

const CONFIG = {
  apiUrl: 'https://api.test',
  clientId: 'client-abc',
  clientSecret: 'shhh',
}

/** A structurally valid JWT whose payload carries `exp`. Never verified here. */
const jwt = (expSecondsFromNow: number) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  return `${b64({ alg: 'HS256' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })}.sig`
}

const tokenResponse = (
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

describe('it refuses to run in a browser', () => {
  it('throws on construction when window exists', () => {
    // The whole class handles a client SECRET. Constructing one in a bundle
    // that reaches a browser is the failure this guard exists for.
    vi.stubGlobal('window', {})
    expect(() => new TokenProvider(CONFIG)).toThrow(
      /never be exposed to browsers/,
    )
  })
})

describe('the request it actually sends', () => {
  it('uses Basic auth and a form body carrying grant_type', async () => {
    // api#40 made grant_type REQUIRED on the Basic path — it used to be ignored
    // there, so any grant, or none, returned a token. This pins that the client
    // sends what the API now demands.
    fetchMock.mockResolvedValue(tokenResponse({ access_token: jwt(900) }))

    await new TokenProvider(CONFIG).getToken()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/auth/token')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Basic ${btoa('client-abc:shhh')}`)
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(init.body).toBe('grant_type=client_credentials')
  })
})

describe('caching', () => {
  it('serves a cached token without a second fetch', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: jwt(900) }))
    const p = new TokenProvider(CONFIG)

    const first = await p.getToken()
    const second = await p.getToken()

    expect(second.token).toBe(first.token)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the token is inside the expiry buffer', async () => {
    // Not "once expired" — a token that expires during the request is no use,
    // so the buffer is what makes the cache safe rather than merely fast.
    fetchMock
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(10) }))
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(900) }))
    const p = new TokenProvider(CONFIG)

    await p.getToken()
    await p.getToken()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('forceRefresh bypasses a perfectly good cached token', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse({ access_token: jwt(900) }),
    )
    const p = new TokenProvider(CONFIG)

    await p.getToken()
    await p.getToken(true)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearCache forces the next call to fetch', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse({ access_token: jwt(900) }),
    )
    const p = new TokenProvider(CONFIG)

    await p.getToken()
    p.clearCache()
    await p.getToken()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('concurrent callers share one fetch', () => {
  it('does not stampede the token endpoint', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: jwt(900) }))
    const p = new TokenProvider(CONFIG)

    const [a, b, c] = await Promise.all([
      p.getToken(),
      p.getToken(),
      p.getToken(),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.token).toBe(b.token)
    expect(b.token).toBe(c.token)
  })

  it('a FAILED fetch does not poison the next attempt', async () => {
    // The in-flight promise must be cleared in a finally, or one failure leaves
    // every later caller awaiting a promise that already rejected. A 500 says
    // nothing about when to ask again, so nothing holds the next call back —
    // unlike a refusal or a Retry-After, below.
    fetchMock
      .mockResolvedValueOnce(
        tokenResponse({ error: 'internal_server_error' }, 500),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(900) }))
    const p = new TokenProvider(CONFIG)

    await expect(p.getToken()).rejects.toBeInstanceOf(LocationServiceException)
    await expect(p.getToken()).resolves.toMatchObject({ success: true })
  })
})

describe('a refusal is remembered, not re-requested on every call (#38)', () => {
  const notActive = () =>
    tokenResponse(
      {
        error: 'invalid_client',
        code: 'InvalidCredentialsException',
        error_description: 'Application is not active',
      },
      401,
    )

  it('answers from memory for the hold, forced or not, then asks again', async () => {
    // A suspended application's /auth/token answers 401 every time, and
    // nothing a retry does changes that. Without a memory of it, a busy server
    // asked /auth/token once per request it served, every one refused.
    fetchMock.mockImplementation(async () => notActive())
    const p = new TokenProvider(CONFIG)

    await expect(p.getToken()).rejects.toThrow('Application is not active')
    await expect(p.getToken()).rejects.toThrow('Application is not active')
    await expect(p.getToken(true)).rejects.toMatchObject({
      message: 'Application is not active',
      statusCode: 401,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TOKEN_REFUSAL_HOLD_MS)
    await expect(p.getToken()).rejects.toThrow('Application is not active')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('drops the cached token: every token minted from refused credentials is dead', async () => {
    // The refusal is about the credentials, so the token they minted is
    // refused too: a suspended application's tokens are revoked on their next
    // use, and a rotated secret revokes every token issued before it.
    fetchMock
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(900) }))
      .mockImplementation(async () => notActive())
    const p = new TokenProvider(CONFIG)

    await p.getToken()
    await expect(p.getToken(true)).rejects.toThrow('Application is not active')
    await expect(p.getToken()).rejects.toThrow('Application is not active')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('remembers a 403 refusal the same way', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse(
        {
          code: 'ApplicationNotActiveException',
          message: 'The application is not active.',
        },
        403,
      ),
    )
    const p = new TokenProvider(CONFIG)

    await expect(p.getToken()).rejects.toMatchObject({ statusCode: 403 })
    await expect(p.getToken()).rejects.toMatchObject({ statusCode: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('remembers a Retry-After across calls, and says how much is left', async () => {
    // A 429 whose Retry-After outlasts the call's budget is thrown at once
    // (#37), and the next call used to start a new fetch immediately: a server
    // handling N requests a second sent N refused token requests a second, for
    // the whole window the endpoint had asked it to wait (#63).
    fetchMock.mockImplementation(async () =>
      tokenResponse(
        {
          code: 'RateLimitExceededException',
          message: 'Request rate exceeded. Retry shortly.',
        },
        429,
        { 'retry-after': '45' },
      ),
    )
    const p = new TokenProvider(CONFIG)

    await expect(p.getToken()).rejects.toMatchObject({ retryAfterMs: 45_000 })
    vi.advanceTimersByTime(15_000)
    const held = await p.getToken().catch((e) => e)
    expect(held.code).toBe('RateLimitExceededException')
    expect(held.retryAfterMs).toBeGreaterThan(29_000)
    expect(held.retryAfterMs).toBeLessThanOrEqual(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000)
    await expect(p.getToken()).rejects.toMatchObject({ statusCode: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the cached token through a Retry-After: only a refusal condemns it', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(900) }))
      .mockImplementation(async () =>
        tokenResponse({ code: 'RateLimitExceededException' }, 429, {
          'retry-after': '45',
        }),
      )
    const p = new TokenProvider(CONFIG)

    const { token } = await p.getToken()
    await expect(p.getToken(true)).rejects.toMatchObject({ statusCode: 429 })
    await expect(p.getToken()).resolves.toMatchObject({ token })
  })
})

describe('failure REJECTS — it never resolves with a stale token', () => {
  it('rejects on 401 rather than resolving success:false', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ error: 'unauthorized' }, 401))

    await expect(new TokenProvider(CONFIG).getToken()).rejects.toBeInstanceOf(
      LocationServiceException,
    )
  })

  it('never hands back the previous token when a refresh fails', async () => {
    // The bug this prevents: a refresh fails, the provider falls back to what it
    // had, and every subsequent call is a guaranteed 401 against the API.
    fetchMock
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(10) }))
      .mockResolvedValue(tokenResponse({ error: 'unauthorized' }, 401))
    const p = new TokenProvider(CONFIG)

    await p.getToken()
    await expect(p.getToken()).rejects.toBeInstanceOf(LocationServiceException)
  })

  it('rejects a 200 that carries no access_token', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ token_type: 'Bearer' }))

    await expect(new TokenProvider(CONFIG).getToken()).rejects.toMatchObject({
      code: 'InvalidCredentialsException',
    })
  })
})

describe('transient is not terminal (#9)', () => {
  it('retries a 503 and succeeds, because the store may come back', async () => {
    // The API answers 503 when its config store is unreachable. The credentials
    // are not in question, so this must not surface as an auth failure.
    fetchMock
      .mockResolvedValueOnce(
        tokenResponse({ error: 'temporarily_unavailable' }, 503),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: jwt(900) }))

    await expect(new TokenProvider(CONFIG).getToken()).resolves.toMatchObject({
      success: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 401 — bad credentials stay bad', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ error: 'unauthorized' }, 401))

    await expect(new TokenProvider(CONFIG).getToken()).rejects.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('which expiry it trusts', () => {
  it("prefers the token's own exp claim over what the response claims", async () => {
    // exp is the only value that cannot disagree with what the API will accept.
    // expires_at is what the response SAYS, and the two can drift.
    const token = jwt(900)
    fetchMock.mockResolvedValue(
      tokenResponse({
        access_token: token,
        expires_at: Date.now() + 99_000_000,
      }),
    )

    const { expiresAt } = await new TokenProvider(CONFIG).getToken()
    expect(expiresAt).toBeLessThan(Date.now() + 1_000_000)
  })

  it('falls back to expires_in when the token carries no exp', async () => {
    const noExp = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.s`
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: noExp, expires_in: 60 }),
    )

    const { expiresAt } = await new TokenProvider(CONFIG).getToken()
    expect(expiresAt).toBeGreaterThan(Date.now() + 50_000)
    expect(expiresAt).toBeLessThan(Date.now() + 70_000)
  })
})
