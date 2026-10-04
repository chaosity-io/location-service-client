import { SearchTextCommand } from '@aws-sdk/client-geo-places'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #63 — a throttled refresh must not fail a request the cached token could
 * still serve.
 *
 * The provider replaces its token once it is inside
 * `TOKEN_REFRESH_BUFFER_SECONDS` of `exp`. When that refresh answers 429 or
 * 503, or the network fails, `send` used to throw before dispatching, for up
 * to a minute, with a token the API would still have accepted. The connector
 * now keeps sending the cached token until its own `exp`, and only then
 * rejects. A refusal (401) still condemns the token (#5).
 */

const jwt = (expSecondsFromNow: number, seq: number) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
    seq,
  })}.s`
}

const json = (
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const ENV_KEYS = [
  'LOCATION_API_URL',
  'LOCATION_SERVICE_API_URL',
  'LOCATION_CLIENT_ID',
  'LOCATION_SERVICE_CLIENT_ID',
  'LOCATION_CLIENT_SECRET',
  'LOCATION_SERVICE_CLIENT_SECRET',
  'LOCATION_ORIGIN',
  'LOCATION_SERVICE_ORIGIN',
]

let fetchMock: ReturnType<typeof vi.fn>
let saved: Record<string, string | undefined>

const tokenCalls = () =>
  fetchMock.mock.calls.filter(([url]: [string]) =>
    String(url).endsWith('/auth/token'),
  )
const dataTokens = () =>
  fetchMock.mock.calls
    .filter(([url]: [string]) => !String(url).endsWith('/auth/token'))
    .map(([, init]: [string, RequestInit]) =>
      new Headers(init.headers).get('Authorization'),
    )

const load = async () => {
  vi.resetModules()
  const { LocationServiceConnector } =
    await import('../src/server/LocationServiceConnector')
  return new LocationServiceConnector({ origin: 'https://app.example.com' })
}

const cmd = () =>
  new SearchTextCommand({ QueryText: 'cafe', BiasPosition: [151.2, -33.8] })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.LOCATION_API_URL = 'https://env.test'
  process.env.LOCATION_CLIENT_ID = 'env-id'
  process.env.LOCATION_CLIENT_SECRET = 'env-secret'
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** One token 30 s from `exp`, then every refresh answers `refresh`. */
const tokenThenRefresh = (refresh: () => Response) => {
  let minted = 0
  const first = jwt(30, 1)
  fetchMock.mockImplementation(async (url: string) => {
    if (!String(url).endsWith('/auth/token'))
      return json(200, { ResultItems: [] })
    minted += 1
    return minted === 1 ? json(200, { access_token: first }) : refresh()
  })
  return first
}

const throttled = () =>
  json(
    429,
    {
      code: 'RateLimitExceededException',
      message: 'Request rate exceeded. Retry shortly.',
    },
    { 'retry-after': '45' },
  )

describe('connector: a retryable refresh failure keeps the cached token until its exp (#63)', () => {
  it('sends with the cached token after one throttled refresh', async () => {
    const first = tokenThenRefresh(throttled)
    const connector = await load()

    await connector.send(cmd())
    await expect(connector.send(cmd())).resolves.toMatchObject({
      ResultItems: [],
    })

    expect(tokenCalls()).toHaveLength(2)
    expect(dataTokens()).toEqual([`Bearer ${first}`, `Bearer ${first}`])
  })

  it('asks /auth/token no more while the Retry-After stands, and keeps serving', async () => {
    const first = tokenThenRefresh(throttled)
    const connector = await load()
    await connector.send(cmd())
    await connector.send(cmd())

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1_000)
      await connector.send(cmd())
    }

    expect(tokenCalls()).toHaveLength(2)
    expect(new Set(dataTokens())).toEqual(new Set([`Bearer ${first}`]))
  })

  it('rejects once the cached token is past its exp, and sends nothing with it', async () => {
    tokenThenRefresh(throttled)
    const connector = await load()
    await connector.send(cmd())
    await connector.send(cmd())
    const sentBefore = dataTokens().length

    vi.advanceTimersByTime(31_000)
    const err = await connector.send(cmd()).catch((e) => e)

    expect(err.statusCode).toBe(429)
    expect(err.retryAfterMs).toBeGreaterThan(0)
    expect(dataTokens()).toHaveLength(sentBefore)
  })

  it('refreshes again once the Retry-After has passed', async () => {
    tokenThenRefresh(throttled)
    const connector = await load()
    await connector.send(cmd())
    await connector.send(cmd())

    vi.advanceTimersByTime(46_000)
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token')
        ? json(200, { access_token: jwt(900, 2) })
        : json(200, { ResultItems: [] }),
    )
    await connector.send(cmd())

    expect(tokenCalls()).toHaveLength(3)
  })

  it('never falls back after a refusal: a 401 clears the cache (#5)', async () => {
    tokenThenRefresh(() =>
      json(401, {
        error: 'invalid_client',
        code: 'InvalidCredentialsException',
        error_description: 'Invalid credentials',
      }),
    )
    const connector = await load()
    await connector.send(cmd())
    const sentBefore = dataTokens().length

    const err = await connector.send(cmd()).catch((e) => e)

    expect(err.statusCode).toBe(401)
    expect(dataTokens()).toHaveLength(sentBefore)
  })

  it('serves a send waiting on the same throttled refresh from the cache too', async () => {
    let minted = 0
    const first = jwt(30, 1)
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).endsWith('/auth/token'))
        return json(200, { ResultItems: [] })
      minted += 1
      if (minted === 1) return json(200, { access_token: first })
      // Slow enough that the second send joins the refresh the first started.
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(throttled()), 50),
      )
    })
    const connector = await load()
    await connector.send(cmd())

    await expect(
      Promise.all([connector.send(cmd()), connector.send(cmd())]),
    ).resolves.toHaveLength(2)

    expect(tokenCalls()).toHaveLength(2)
    expect(dataTokens()).toEqual([
      `Bearer ${first}`,
      `Bearer ${first}`,
      `Bearer ${first}`,
    ])
  })

  it('keeps a 5 s margin: a cached token closer than that to its exp is not sent', async () => {
    let minted = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).endsWith('/auth/token'))
        return json(200, { ResultItems: [] })
      minted += 1
      return minted === 1 ? json(200, { access_token: jwt(3, 1) }) : throttled()
    })
    const connector = await load()
    await connector.send(cmd())

    const err = await connector.send(cmd()).catch((e) => e)

    expect(err.statusCode).toBe(429)
    expect(dataTokens()).toHaveLength(1)
  })

  it('keeps the cached token through a network fault on the refresh', async () => {
    const first = tokenThenRefresh(() => {
      throw new TypeError('fetch failed')
    })
    const connector = await load()
    await connector.send(cmd())

    await expect(connector.send(cmd())).resolves.toMatchObject({
      ResultItems: [],
    })
    expect(dataTokens().at(-1)).toBe(`Bearer ${first}`)
  })
})

describe('a connector given its own TokenProvider falls back as the environment source does (#63)', () => {
  it('sends the cached token after one throttled refresh', async () => {
    const first = tokenThenRefresh(throttled)
    vi.resetModules()
    const { LocationServiceConnector } =
      await import('../src/server/LocationServiceConnector')
    const { TokenProvider } = await import('../src/auth/TokenProvider')
    const provider = new TokenProvider({
      apiUrl: 'https://env.test',
      clientId: 'own-id',
      clientSecret: 'own-secret',
    })
    const connector = new LocationServiceConnector({
      apiUrl: 'https://env.test',
      origin: 'https://app.example.com',
      getToken: (forceRefresh, options) =>
        provider.getToken(forceRefresh, options),
    })

    await connector.send(cmd())
    await expect(connector.send(cmd())).resolves.toMatchObject({
      ResultItems: [],
    })

    expect(tokenCalls()).toHaveLength(2)
    expect(dataTokens()).toEqual([`Bearer ${first}`, `Bearer ${first}`])
  })
})

describe('getClientConfig keeps refusing inside the buffer (#63 constraint)', () => {
  it('rejects with retryAfterMs rather than hand a browser a token it would replace at once', async () => {
    tokenThenRefresh(throttled)
    vi.resetModules()
    const { getClientConfig } = await import('../src/server/getClientConfig')

    await getClientConfig()
    const err = await getClientConfig().catch((e) => e)

    expect(err.statusCode).toBe(429)
    expect(err.retryAfterMs).toBeGreaterThan(0)
  })
})
