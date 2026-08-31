import { SearchTextCommand } from '@aws-sdk/client-geo-places'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocationServiceConnector } from '../src/server/LocationServiceConnector'

/**
 * LocationServiceConnector was at 0% — the server-side send path (#6 / T35).
 *
 * Three things here are easy to break without noticing: the Origin header the
 * API requires on every data request, the header precedence that stops a caller
 * overwriting Authorization, and the bias rounding that decides which cache
 * pool a request lands in (api#65). None of them fails loudly.
 */

const jwt = (claims: Record<string, unknown> = {}) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  })}.s`
}

const ok = () =>
  new Response(JSON.stringify({ ResultItems: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Every environment variable the server surface reads. Cleared for every test:
 * the connector now COMPLETES its configuration from the environment (#45), so
 * a developer's own LOCATION_API_URL would otherwise silently change what these
 * tests exercise.
 */
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
/** Every token `/auth/token` has handed out this test, in order. */
let issued: string[]

const sent = () => {
  const [url, init] = fetchMock.mock.calls[0]
  return { url, init, body: JSON.parse(init.body) }
}

/** The data requests only — the env path spends call 0 on `/auth/token`. */
const dataCalls = () =>
  fetchMock.mock.calls.filter(
    ([url]: [string]) => !String(url).endsWith('/auth/token'),
  )

const tokenCalls = () =>
  fetchMock.mock.calls.filter(([url]: [string]) =>
    String(url).endsWith('/auth/token'),
  )

const lastData = () => {
  const calls = dataCalls()
  const [url, init] = calls[calls.length - 1]!
  return { url, init, body: JSON.parse(init.body) }
}

const mintedToken = () => {
  issued.push(jwt({ seq: issued.length + 1 }))
  return new Response(JSON.stringify({ access_token: issued.at(-1) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const apiError = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * A fresh module graph, because `serverTokenSource` reaches a PROCESS-WIDE
 * TokenProvider singleton. Without the reset, one test's cached token is handed
 * to the next and the refresh assertions all pass for the wrong reason.
 *
 * The exception class is imported from the same graph deliberately —
 * `vi.resetModules` rebuilds it, and `instanceof` compares identity.
 */
const load = async () => {
  vi.resetModules()
  const [{ LocationServiceConnector }, { LocationServiceException }] =
    await Promise.all([
      import('../src/server/LocationServiceConnector'),
      import('../src/errors/LocationServiceException'),
    ])
  return { LocationServiceConnector, LocationServiceException }
}

const withEnvCredentials = () => {
  process.env.LOCATION_API_URL = 'https://env.test'
  process.env.LOCATION_CLIENT_ID = 'env-id'
  process.env.LOCATION_CLIENT_SECRET = 'env-secret'
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  issued = []
  fetchMock = vi
    .fn()
    .mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token') ? mintedToken() : ok(),
    )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.unstubAllGlobals()
})

const connector = (over: Record<string, unknown> = {}) =>
  new LocationServiceConnector({
    apiUrl: 'https://api.test',
    token: jwt(),
    ...over,
  })

describe('the request it builds', () => {
  it('posts to the endpoint the command maps to', async () => {
    await connector().send(new SearchTextCommand({ QueryText: 'x' }))
    expect(sent().url).toBe('https://api.test/address/search/text')
    expect(sent().init.method).toBe('POST')
  })

  it('sends the bearer token', async () => {
    const token = jwt()
    await connector({ token }).send(new SearchTextCommand({ QueryText: 'x' }))
    expect(sent().init.headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('sends the connector-wide Origin, which the API requires', async () => {
    // Every data request needs it; the samples used to set it by hand.
    await connector({ origin: 'https://app.example.com' }).send(
      new SearchTextCommand({ QueryText: 'x' }),
    )
    expect(sent().init.headers.Origin).toBe('https://app.example.com')
  })

  it('lets a per-call Origin beat the connector default', async () => {
    await connector({ origin: 'https://default.example' }).send(
      new SearchTextCommand({ QueryText: 'x' }),
      { headers: { Origin: 'https://per-call.example' } },
    )
    expect(sent().init.headers.Origin).toBe('https://per-call.example')
  })

  it('does NOT let a caller header overwrite Authorization', async () => {
    // Header precedence is the whole reason the system headers are spread last.
    const token = jwt()
    await connector({ token }).send(new SearchTextCommand({ QueryText: 'x' }), {
      headers: { Authorization: 'Bearer not-yours' },
    })
    expect(sent().init.headers.Authorization).toBe(`Bearer ${token}`)
  })

  it.each(['authorization', 'AUTHORIZATION'])(
    'does not let a caller %s CORRUPT the token either',
    async (header) => {
      // Spreading the system headers last only out-ranks the caller's key when
      // it is spelled identically. A case variant survived beside it, and
      // fetch's Headers fill appends — so `Bearer not-yours` was not ignored,
      // it was prepended: `Bearer not-yours, Bearer <real>`.
      const token = jwt()
      await connector({ token }).send(
        new SearchTextCommand({ QueryText: 'x' }),
        { headers: { [header]: 'Bearer not-yours' } },
      )
      expect(new Headers(sent().init.headers).get('authorization')).toBe(
        `Bearer ${token}`,
      )
    },
  )

  it('does not let a caller content-type corrupt the JSON body header', async () => {
    await connector().send(new SearchTextCommand({ QueryText: 'x' }), {
      headers: { 'content-type': 'text/plain' },
    })
    expect(new Headers(sent().init.headers).get('content-type')).toBe(
      'application/json',
    )
  })

  it('omits Origin entirely when none is configured', async () => {
    await connector().send(new SearchTextCommand({ QueryText: 'x' }))
    expect(sent().init.headers.Origin).toBeUndefined()
  })
})

describe('bias precision comes from the token (api#65)', () => {
  it('rounds to the 3 dp floor when the token claims nothing', async () => {
    await connector().send(
      new SearchTextCommand({
        QueryText: 'x',
        BiasPosition: [151.21536789, -33.85681234],
      }),
    )
    expect(sent().body.BiasPosition).toEqual([151.215, -33.857])
  })

  it('honours a higher precision the application is entitled to', async () => {
    // Precision decides which cache pool the request lands in, so a wrong value
    // is a silent cache split rather than an error.
    await connector({ token: jwt({ biasDecimals: 5 }) }).send(
      new SearchTextCommand({
        QueryText: 'x',
        BiasPosition: [151.21536789, -33.85681234],
      }),
    )
    expect(sent().body.BiasPosition).toEqual([151.21537, -33.85681])
  })

  it('leaves a request without a position alone', async () => {
    await connector().send(new SearchTextCommand({ QueryText: 'x' }))
    expect(sent().body).toEqual({ QueryText: 'x' })
  })
})

describe('when there is no token', () => {
  it('refuses with advice rather than sending Bearer undefined', async () => {
    // `token: undefined` is no longer "the caller supplied a token" — since #45
    // a partial config is COMPLETED from the environment, and there is nothing
    // there either. Either way nothing is sent.
    const c = new LocationServiceConnector({
      apiUrl: 'https://api.test',
      token: undefined as unknown as string,
    })

    await expect(
      c.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ code: 'ValidationException' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when a getToken callback resolves nothing', async () => {
    const c = new LocationServiceConnector({
      apiUrl: 'https://api.test',
      getToken: async () => undefined,
    })

    await expect(
      c.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ code: 'InvalidCredentialsException' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when no apiUrl can be found anywhere', async () => {
    const c = new LocationServiceConnector({ token: jwt() })

    await expect(
      c.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ code: 'ValidationException' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('exactly one Origin leaves, whatever the caller capitalised', () => {
  /**
   * `fetch` builds its Headers by APPENDING, so a record carrying both `Origin`
   * and `origin` goes out as `Origin: a, b` — and the API matches the allowed
   * domain exactly, so it 403s. Two keys with the same value fare no better
   * (`Origin: x, x`). The connector therefore drops the caller's own spelling
   * and sets the header once itself.
   */

  const originsSent = () =>
    Object.keys(sent().init.headers).filter(
      (key) => key.toLowerCase() === 'origin',
    )

  /** What fetch would actually put on the wire. */
  const wireOrigin = () => new Headers(sent().init.headers).get('origin')

  it.each(['Origin', 'origin', 'ORIGIN'])(
    'lets a per-call %s beat the connector default, once',
    async (header) => {
      await connector({ origin: 'https://default.example' }).send(
        new SearchTextCommand({ QueryText: 'x' }),
        { headers: { [header]: 'https://per-call.example' } },
      )

      expect(originsSent()).toHaveLength(1)
      expect(wireOrigin()).toBe('https://per-call.example')
    },
  )

  it('does not double a per-call Origin that repeats the default', async () => {
    await connector({ origin: 'https://same.example' }).send(
      new SearchTextCommand({ QueryText: 'x' }),
      { headers: { origin: 'https://same.example' } },
    )

    expect(wireOrigin()).toBe('https://same.example')
  })

  it('keeps every other caller header untouched', async () => {
    await connector({ origin: 'https://default.example' }).send(
      new SearchTextCommand({ QueryText: 'x' }),
      { headers: { origin: 'https://per-call.example', 'X-Trace': 'abc' } },
    )

    expect(sent().init.headers['X-Trace']).toBe('abc')
  })
})

describe('getAppConfig reads the token, not the API', () => {
  it('returns the claims the token carries', async () => {
    const c = connector({
      token: jwt({ countries: ['AU', 'NZ'], biasDecimals: 4 }),
    })
    await expect(c.getAppConfig()).resolves.toEqual({
      countries: ['AU', 'NZ'],
      biasDecimals: 4,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns {} when the token carries no application config', async () => {
    await expect(connector().getAppConfig()).resolves.toEqual({})
  })

  it('needs no apiUrl, because it reads claims rather than sending anything', async () => {
    // The URL is resolved when a request is about to go out, not when the token
    // source is built — demanding it up front made this throw on a connector
    // configured with nothing but a token.
    const c = new LocationServiceConnector({ token: jwt({ biasDecimals: 4 }) })

    await expect(c.getAppConfig()).resolves.toEqual({ biasDecimals: 4 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a getToken callback is supported alongside a static token', () => {
  it('calls getToken when the config provides one', async () => {
    const token = jwt()
    const getToken = vi.fn().mockResolvedValue({ token })
    const c = new LocationServiceConnector({
      apiUrl: 'https://api.test',
      getToken,
    } as never)

    await c.send(new SearchTextCommand({ QueryText: 'x' }))

    expect(getToken).toHaveBeenCalled()
    expect(sent().init.headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('accepts a getToken that resolves a bare string', async () => {
    const token = jwt()
    const c = new LocationServiceConnector({
      apiUrl: 'https://api.test',
      getToken: async () => token,
    } as never)

    await c.send(new SearchTextCommand({ QueryText: 'x' }))
    expect(sent().init.headers.Authorization).toBe(`Bearer ${token}`)
  })
})

describe('configuration is COMPLETED from the environment, not replaced (#45)', () => {
  /**
   * The constructor used to be all-or-nothing: `config ? Promise.resolve(config)
   * : getClientConfig()`. So the zero-argument form documented everywhere had
   * credentials and could never send an Origin (403 on every data request), and
   * `{ origin }` — the obvious repair — took the other branch and had no
   * credentials at all. Neither form could make a successful data call.
   */

  it('takes credentials AND an origin, which no single form could before', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({ origin: 'https://app.example' }).send(
      new SearchTextCommand({ QueryText: 'x' }),
    )

    expect(tokenCalls()).toHaveLength(1)
    expect(lastData().url).toBe('https://env.test/address/search/text')
    expect(lastData().init.headers.Origin).toBe('https://app.example')
    expect(lastData().init.headers.Authorization).toBe(`Bearer ${issued[0]}`)
  })

  it('reads the Origin from LOCATION_ORIGIN, so the zero-arg form works', async () => {
    withEnvCredentials()
    process.env.LOCATION_ORIGIN = 'https://from-env.example'
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector().send(
      new SearchTextCommand({ QueryText: 'x' }),
    )

    expect(lastData().init.headers.Origin).toBe('https://from-env.example')
  })

  it('accepts the LOCATION_SERVICE_ORIGIN spelling too', async () => {
    // The fourth member of the LOCATION_SERVICE_* family; the other three are
    // proven in test/get-client-config.test.ts.
    withEnvCredentials()
    process.env.LOCATION_SERVICE_ORIGIN = 'https://alt-spelling.example'
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector().send(
      new SearchTextCommand({ QueryText: 'x' }),
    )

    expect(lastData().init.headers.Origin).toBe('https://alt-spelling.example')
  })

  it('prefers LOCATION_ORIGIN over the LOCATION_SERVICE_ spelling', async () => {
    withEnvCredentials()
    process.env.LOCATION_ORIGIN = 'https://primary.example'
    process.env.LOCATION_SERVICE_ORIGIN = 'https://alt-spelling.example'
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector().send(
      new SearchTextCommand({ QueryText: 'x' }),
    )

    expect(lastData().init.headers.Origin).toBe('https://primary.example')
  })

  it('takes credentials from the CONFIG when the environment has none', async () => {
    // ConnectorConfig carries clientId/clientSecret so the merge story is
    // "complete it from wherever", not "everything but the credentials".
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({
      apiUrl: 'https://api.test',
      clientId: 'config-id',
      clientSecret: 'config-secret',
      origin: 'https://app.example',
    }).send(new SearchTextCommand({ QueryText: 'x' }))

    expect(tokenCalls()).toHaveLength(1)
    expect(tokenCalls()[0]![0]).toBe('https://api.test/auth/token')
    // Basic base64("config-id:config-secret")
    expect(tokenCalls()[0]![1].headers.Authorization).toBe(
      `Basic ${Buffer.from('config-id:config-secret').toString('base64')}`,
    )
    expect(lastData().init.headers.Authorization).toBe(`Bearer ${issued[0]}`)
  })

  it('lets config credentials beat the environment', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({
      clientId: 'config-id',
      clientSecret: 'config-secret',
      origin: 'https://app.example',
    }).send(new SearchTextCommand({ QueryText: 'x' }))

    expect(tokenCalls()[0]![1].headers.Authorization).toBe(
      `Basic ${Buffer.from('config-id:config-secret').toString('base64')}`,
    )
  })

  it('treats an empty constructor origin as missing, not as a choice', async () => {
    // `origin: ''` used to suppress the environment and then produce an error
    // advising the caller to set LOCATION_ORIGIN — which they had set.
    withEnvCredentials()
    process.env.LOCATION_ORIGIN = 'https://from-env.example'
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({ origin: '' }).send(
      new SearchTextCommand({ QueryText: 'x' }),
    )

    expect(lastData().init.headers.Origin).toBe('https://from-env.example')
  })

  it('treats an empty per-call origin as missing too', async () => {
    withEnvCredentials()
    process.env.LOCATION_ORIGIN = 'https://from-env.example'
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector().send(
      new SearchTextCommand({ QueryText: 'x' }),
      { headers: { origin: '' } },
    )

    expect(lastData().init.headers.Origin).toBe('https://from-env.example')
  })

  it('lets an explicit origin beat LOCATION_ORIGIN', async () => {
    withEnvCredentials()
    process.env.LOCATION_ORIGIN = 'https://from-env.example'
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({
      origin: 'https://explicit.example',
    }).send(new SearchTextCommand({ QueryText: 'x' }))

    expect(lastData().init.headers.Origin).toBe('https://explicit.example')
  })

  it('takes the apiUrl from the environment when only a token is passed', async () => {
    process.env.LOCATION_API_URL = 'https://env.test'
    const token = jwt()
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({ token }).send(
      new SearchTextCommand({ QueryText: 'x' }),
    )

    expect(lastData().url).toBe('https://env.test/address/search/text')
    expect(tokenCalls()).toHaveLength(0)
  })

  it('lets an explicit token win outright — the environment is never read', async () => {
    // A caller managing its own credentials must not have another
    // application's silently substituted underneath it.
    withEnvCredentials()
    const token = jwt({ seq: 'explicit' })
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({
      apiUrl: 'https://api.test',
      token,
    }).send(new SearchTextCommand({ QueryText: 'x' }))

    expect(tokenCalls()).toHaveLength(0)
    expect(lastData().url).toBe('https://api.test/address/search/text')
    expect(lastData().init.headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('lets an explicit getToken win outright too', async () => {
    withEnvCredentials()
    const token = jwt({ seq: 'callback' })
    const { LocationServiceConnector } = await load()

    await new LocationServiceConnector({
      apiUrl: 'https://api.test',
      getToken: async () => ({ token }),
    }).send(new SearchTextCommand({ QueryText: 'x' }))

    expect(tokenCalls()).toHaveLength(0)
    expect(lastData().init.headers.Authorization).toBe(`Bearer ${token}`)
  })

  it('does not touch the network from the constructor', async () => {
    // It used to: `new LocationServiceConnector()` started a /auth/token round
    // trip nothing was awaiting yet, so a misconfigured process got an
    // unhandled rejection before it had made a request.
    withEnvCredentials()
    const { LocationServiceConnector } = await load()

    new LocationServiceConnector()
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the token refreshes, so the connector outlives its exp (#36)', () => {
  it('mints a new token once the old one has expired', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-31T00:00:00Z'))
      withEnvCredentials()
      const { LocationServiceConnector } = await load()
      const c = new LocationServiceConnector({ origin: 'https://app.example' })

      await c.send(new SearchTextCommand({ QueryText: 'first' }))
      expect(lastData().init.headers.Authorization).toBe(`Bearer ${issued[0]}`)

      // Past the 900 s exp of the token minted above.
      vi.setSystemTime(Date.now() + 901_000)
      await c.send(new SearchTextCommand({ QueryText: 'second' }))

      expect(tokenCalls()).toHaveLength(2)
      expect(issued[1]).not.toBe(issued[0])
      expect(lastData().init.headers.Authorization).toBe(`Bearer ${issued[1]}`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses the cached token while it is still good', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    const c = new LocationServiceConnector({ origin: 'https://app.example' })

    await c.send(new SearchTextCommand({ QueryText: 'a' }))
    await c.send(new SearchTextCommand({ QueryText: 'b' }))

    expect(tokenCalls()).toHaveLength(1)
    expect(dataCalls()).toHaveLength(2)
  })
})

describe('a 401 is retried exactly once, with a fresh token (#36)', () => {
  const unauthorized = () => apiError(401, { message: 'Unauthorized' })

  it('refreshes and retries when the API rejects the token', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    let dataSeen = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/auth/token')) return mintedToken()
      dataSeen += 1
      return dataSeen === 1 ? unauthorized() : ok()
    })

    const c = new LocationServiceConnector({ origin: 'https://app.example' })
    await expect(
      c.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })

    expect(dataCalls()).toHaveLength(2)
    expect(dataCalls()[0]![1].headers.Authorization).toBe(`Bearer ${issued[0]}`)
    expect(dataCalls()[1]![1].headers.Authorization).toBe(`Bearer ${issued[1]}`)
  })

  it('gives up after one retry rather than looping', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token') ? mintedToken() : unauthorized(),
    )

    const c = new LocationServiceConnector({ origin: 'https://app.example' })
    await expect(
      c.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(dataCalls()).toHaveLength(2)
  })

  it('does NOT retry a static token — the second request would be identical', async () => {
    // And billed. A fixed string cannot be refreshed, so there is nothing to
    // retry WITH.
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async () => unauthorized())

    await expect(
      new LocationServiceConnector({
        apiUrl: 'https://api.test',
        token: jwt(),
      }).send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(dataCalls()).toHaveLength(1)
  })

  it('does NOT retry when the refresh hands back the same token', async () => {
    const token = jwt()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async () => unauthorized())

    await expect(
      new LocationServiceConnector({
        apiUrl: 'https://api.test',
        getToken: async () => ({ token }),
      }).send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(dataCalls()).toHaveLength(1)
  })

  it('passes forceRefresh:true to a caller getToken, and uses what comes back', async () => {
    const stale = jwt({ seq: 'stale' })
    const fresh = jwt({ seq: 'fresh' })
    const getToken = vi.fn(async (forceRefresh?: boolean) => ({
      token: forceRefresh ? fresh : stale,
    }))
    const { LocationServiceConnector } = await load()
    let dataSeen = 0
    fetchMock.mockImplementation(async () => {
      dataSeen += 1
      return dataSeen === 1 ? unauthorized() : ok()
    })

    await new LocationServiceConnector({
      apiUrl: 'https://api.test',
      getToken,
    }).send(new SearchTextCommand({ QueryText: 'x' }))

    expect(getToken).toHaveBeenNthCalledWith(2, true)
    expect(dataCalls()[1]![1].headers.Authorization).toBe(`Bearer ${fresh}`)
  })

  it('re-rounds the bias for the replacement token, whose claims may differ', async () => {
    // biasDecimals is a claim ON the token and the body is shaped from it, so a
    // retry reusing the first attempt's body would send the old precision — a
    // silent cache split, not an error. Mirrors the browser-path test in
    // test/client-token-retry.test.ts.
    const { LocationServiceConnector } = await load()
    let dataSeen = 0
    fetchMock.mockImplementation(async () => {
      dataSeen += 1
      return dataSeen === 1 ? unauthorized() : ok()
    })

    await new LocationServiceConnector({
      apiUrl: 'https://api.test',
      getToken: async (forceRefresh) => ({
        token: jwt({ biasDecimals: forceRefresh ? 5 : 3 }),
      }),
    }).send(
      new SearchTextCommand({
        QueryText: 'x',
        BiasPosition: [151.21536789, -33.85681234],
      }),
    )

    const bodies = dataCalls().map(([, init]) => JSON.parse(init.body))
    expect(bodies[0].BiasPosition).toEqual([151.215, -33.857])
    expect(bodies[1].BiasPosition).toEqual([151.21537, -33.85681])
  })

  it('does NOT retry a 403 — a new token cannot fix an Origin or a Deny', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token')
        ? mintedToken()
        : apiError(403, {
            message: 'Origin not allowed',
            code: 'OriginNotAllowedException',
          }),
    )

    await expect(
      new LocationServiceConnector({ origin: 'https://app.example' }).send(
        new SearchTextCommand({ QueryText: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'OriginNotAllowedException' })

    expect(dataCalls()).toHaveLength(1)
  })
})

describe('a 403 on a request that carried no Origin says so (#45)', () => {
  const originDenied = () =>
    apiError(403, {
      message: 'Origin not allowed',
      code: 'OriginNotAllowedException',
    })

  it('names the missing header and how to supply it', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token') ? mintedToken() : originDenied(),
    )

    const err = await new LocationServiceConnector()
      .send(new SearchTextCommand({ QueryText: 'x' }))
      .catch((e) => e)

    expect(err.code).toBe('OriginNotAllowedException')
    expect(err.statusCode).toBe(403)
    // The API's own message survives; the advice is appended to it.
    expect(err.message).toContain('Origin not allowed')
    expect(err.message).toContain('carried no Origin header')
    expect(err.message).toContain('LOCATION_ORIGIN')
  })

  it('leaves the API message alone when an Origin WAS sent', async () => {
    // Then the Origin is wrong, not missing, and telling the caller to set one
    // sends them looking in the wrong place.
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token') ? mintedToken() : originDenied(),
    )

    const err = await new LocationServiceConnector({
      origin: 'https://wrong.example',
    })
      .send(new SearchTextCommand({ QueryText: 'x' }))
      .catch((e) => e)

    expect(err.message).toBe('Origin not allowed')
  })

  it('counts a per-call Origin as sent, whatever its capitalisation', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token') ? mintedToken() : originDenied(),
    )

    const err = await new LocationServiceConnector()
      .send(new SearchTextCommand({ QueryText: 'x' }), {
        headers: { origin: 'https://per-call.example' },
      })
      .catch((e) => e)

    expect(err.message).toBe('Origin not allowed')
  })

  it('leaves an unrelated 403 alone', async () => {
    withEnvCredentials()
    const { LocationServiceConnector } = await load()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/auth/token')
        ? mintedToken()
        : apiError(403, { message: 'Forbidden' }),
    )

    const err = await new LocationServiceConnector()
      .send(new SearchTextCommand({ QueryText: 'x' }))
      .catch((e) => e)

    expect(err.message).toBe('Forbidden')
  })
})
