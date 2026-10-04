import { SearchTextCommand } from '@aws-sdk/client-geo-places'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #62 — the wait for a token is part of the call.
 *
 * `send(cmd, { signal, overallTimeoutMs })` says those options bound the whole
 * call, waits included. The token step ran before the call's deadline existed
 * and without its signal, so an abort surfaced only when `/auth/token` gave up,
 * and the budget was ignored. Each caller's own signal and deadline are now
 * raced against the token wait, without aborting a fetch other callers share.
 */

const jwt = () => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 900,
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

const after = <T>(ms: number, value: () => T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms))

/** A fetch that never answers, and rejects only when its signal aborts. */
const hangs = (init?: RequestInit) =>
  new Promise<Response>((_, reject) =>
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted', 'AbortError')),
    ),
  )

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

const connector = async () => {
  vi.resetModules()
  const { LocationServiceConnector } =
    await import('../src/server/LocationServiceConnector')
  return new LocationServiceConnector({ origin: 'https://app.example.com' })
}

const cmd = () =>
  new SearchTextCommand({ QueryText: 'cafe', BiasPosition: [151.2, -33.8] })

/** When `p` settled, in ms since `start`, and how. */
const settle = async (p: Promise<unknown>, start: number) => {
  const outcome = await p.then(
    (value) => ({ value }),
    (error: { code?: string }) => ({ code: error?.code }),
  )
  return { ...outcome, at: Date.now() - start }
}

beforeEach(() => {
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
})

/** /auth/token answers 503 Retry-After: 5, two seconds after it is asked. */
const tokenUnavailable = () =>
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    String(url).endsWith('/auth/token')
      ? after(2_000, () =>
          json(
            503,
            {
              error: 'temporarily_unavailable',
              code: 'ServiceUnavailableException',
            },
            { 'retry-after': '5' },
          ),
        )
      : hangs(init),
  )

describe('connector: the token wait honours the caller (#62)', () => {
  it('rejects with AbortedException within a few ms of the abort', async () => {
    tokenUnavailable()
    const c = await connector()
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 100)

    const result = await settle(
      c.send(cmd(), { signal: controller.signal }),
      start,
    )

    expect(result.code).toBe('AbortedException')
    expect(result.at).toBeLessThan(150)
  })

  it('rejects with TimeoutException at its overall budget', async () => {
    tokenUnavailable()
    const c = await connector()
    const start = Date.now()

    const result = await settle(c.send(cmd(), { overallTimeoutMs: 300 }), start)

    expect(result.code).toBe('TimeoutException')
    expect(result.at).toBeGreaterThanOrEqual(290)
    expect(result.at).toBeLessThan(400)
  })

  it("leaves a second caller waiting on the same token fetch unaffected by the first's abort", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token')
        ? after(300, () => json(200, { access_token: jwt() }))
        : json(200, { ResultItems: [] }),
    )
    const c = await connector()
    const controller = new AbortController()
    const first = c.send(cmd(), { signal: controller.signal })
    const second = c.send(cmd())
    setTimeout(() => controller.abort(), 100)

    await expect(first).rejects.toMatchObject({ code: 'AbortedException' })
    await expect(second).resolves.toMatchObject({ ResultItems: [] })
    expect(
      fetchMock.mock.calls.filter(([u]: [string]) =>
        String(u).endsWith('/auth/token'),
      ),
    ).toHaveLength(1)
  })

  it('gives the data request only what the token wait left of the budget', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      String(url).endsWith('/auth/token')
        ? after(200, () => json(200, { access_token: jwt() }))
        : hangs(init),
    )
    const c = await connector()
    const start = Date.now()

    const result = await settle(c.send(cmd(), { overallTimeoutMs: 400 }), start)

    expect(result.code).toBe('TimeoutException')
    expect(result.at).toBeLessThan(500)
  })
})

describe('GeoPlacesClient: the refreshToken wait honours the caller (#62)', () => {
  it('rejects on abort while a refreshToken never settles', async () => {
    const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
    const client = new GeoPlacesClient({
      apiUrl: 'https://api.test',
      refreshToken: () => new Promise<string>(() => {}),
    })
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 100)

    const result = await settle(
      client.send(cmd(), { signal: controller.signal }),
      start,
    )

    expect(result.code).toBe('AbortedException')
    expect(result.at).toBeLessThan(150)
  })

  it('rejects with TimeoutException while a refreshToken never settles', async () => {
    const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
    const client = new GeoPlacesClient({
      apiUrl: 'https://api.test',
      refreshToken: () => new Promise<string>(() => {}),
    })
    const start = Date.now()

    const result = await settle(
      client.send(cmd(), { overallTimeoutMs: 200 }),
      start,
    )

    expect(result.code).toBe('TimeoutException')
    expect(result.at).toBeLessThan(300)
  })
})

/** The data route refuses the token; /auth/token mints once, then never answers. */
const refusedThenTokenHangs = () => {
  let minted = 0
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith('/auth/token'))
      return json(401, {
        code: 'UnauthorizedException',
        message: 'Unauthorized',
      })
    minted += 1
    return minted === 1 ? json(200, { access_token: jwt() }) : hangs(init)
  })
}

describe('connector: the forced re-mint after a 401 honours the caller (#62)', () => {
  it('rejects with AbortedException within a few ms of the abort', async () => {
    refusedThenTokenHangs()
    const c = await connector()
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 100)

    const result = await settle(
      c.send(cmd(), { signal: controller.signal }),
      start,
    )

    expect(result.code).toBe('AbortedException')
    expect(result.at).toBeLessThan(150)
  })

  it('rejects with TimeoutException at its overall budget', async () => {
    refusedThenTokenHangs()
    const c = await connector()
    const start = Date.now()

    const result = await settle(c.send(cmd(), { overallTimeoutMs: 300 }), start)

    expect(result.code).toBe('TimeoutException')
    expect(result.at).toBeGreaterThanOrEqual(290)
    expect(result.at).toBeLessThan(400)
  })
})

describe('GeoPlacesClient: the refreshToken wait after a 401 honours the caller (#62)', () => {
  const refusedClient = async () => {
    fetchMock.mockImplementation(async () =>
      json(401, { code: 'UnauthorizedException', message: 'Unauthorized' }),
    )
    const { GeoPlacesClient } = await import('../src/client/GeoPlacesClient')
    return new GeoPlacesClient({
      apiUrl: 'https://api.test',
      getToken: () => 'refused',
      refreshToken: () => new Promise<string>(() => {}),
    })
  }

  it('rejects on abort while the refreshToken never settles', async () => {
    const client = await refusedClient()
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 100)

    const result = await settle(
      client.send(cmd(), { signal: controller.signal }),
      start,
    )

    expect(result.code).toBe('AbortedException')
    expect(result.at).toBeLessThan(150)
  })

  it('rejects with TimeoutException while the refreshToken never settles', async () => {
    const client = await refusedClient()
    const start = Date.now()

    const result = await settle(
      client.send(cmd(), { overallTimeoutMs: 200 }),
      start,
    )

    expect(result.code).toBe('TimeoutException')
    expect(result.at).toBeLessThan(300)
  })
})
