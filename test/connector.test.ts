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

let fetchMock: ReturnType<typeof vi.fn>

const sent = () => {
  const [url, init] = fetchMock.mock.calls[0]
  return { url, init, body: JSON.parse(init.body) }
}

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
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
    const c = new LocationServiceConnector({
      apiUrl: 'https://api.test',
      token: undefined as unknown as string,
    })

    await expect(
      c.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ code: 'InvalidCredentialsException' })
    expect(fetchMock).not.toHaveBeenCalled()
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
