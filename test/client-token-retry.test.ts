import { SearchTextCommand } from '@aws-sdk/client-geo-places'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeoPlacesClient } from '../src/client/GeoPlacesClient'

/**
 * The browser client's half of #36: recovering from a token the API has stopped
 * accepting.
 *
 * `getToken` is synchronous by contract — it is read while a request is being
 * built — so it can only ever hand back the token already in hand. That left
 * nothing in this library able to recover from a token revoked, or a secret
 * rotated, before its `exp`: every request 401'd until the 60 s refresh buffer
 * elapsed on its own. `refreshToken` is the async escape hatch, and the guard
 * that matters is the one that DOESN'T retry, because a repeat of a doomed
 * request is a second billed request.
 */

const API = 'https://api.test'

const ok = () =>
  new Response(JSON.stringify({ ResultItems: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const unauthorized = () =>
  new Response(JSON.stringify({ message: 'Unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>

const authHeaders = () =>
  fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)

/** 401 first, then 200 — the shape of a token replaced mid-session. */
const rejectThenAccept = () => {
  let seen = 0
  fetchMock.mockImplementation(async () => {
    seen += 1
    return seen === 1 ? unauthorized() : ok()
  })
}

beforeEach(() => {
  fetchMock = vi.fn().mockImplementation(async () => ok())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a 401 is retried once when a replacement token exists (#36)', () => {
  it('asks refreshToken and retries with what it returns', async () => {
    rejectThenAccept()
    const refreshToken = vi.fn().mockResolvedValue('fresh')
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'stale',
      refreshToken,
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(authHeaders()).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('falls back to re-reading getToken, for a background refresh that landed', async () => {
    let current = 'stale'
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'unused',
      getToken: () => current,
    })

    // What the React provider does: reading a stale token starts a refresh in
    // the background, so by the time the 401 comes back the new one is there.
    fetchMock.mockImplementationOnce(async () => {
      current = 'fresh'
      return unauthorized()
    })

    await client.send(new SearchTextCommand({ QueryText: 'x' }))

    expect(authHeaders()).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('retries at most once', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    let n = 0
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'stale',
      refreshToken: async () => `fresh-${++n}`,
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('and NOT retried when there is nothing new to send', () => {
  it('does not retry without a refreshToken and a static token', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const client = new GeoPlacesClient({ apiUrl: API, token: 'stale' })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when refreshToken returns the same token', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'stale',
      refreshToken: async () => 'stale',
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry when refreshToken returns nothing', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'stale',
      refreshToken: async () => undefined,
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403 — a fresh token cannot fix an Origin or a Deny', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            message: 'Origin not allowed',
            code: 'OriginNotAllowedException',
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    )
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'stale',
      refreshToken: async () => 'fresh',
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toMatchObject({ code: 'OriginNotAllowedException' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-rounds the bias for the replacement token, whose claims may differ', async () => {
    // biasDecimals is a claim ON the token, and the request body is shaped from
    // it. A retry that reused the first attempt's body would send the old
    // application's precision — a silent cache split, not an error.
    const jwt = (claims: Record<string, unknown>) => {
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url')
      return `${b64({ alg: 'HS256' })}.${b64(claims)}.s`
    }
    rejectThenAccept()
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: jwt({ biasDecimals: 3 }),
      refreshToken: async () => jwt({ biasDecimals: 5 }),
    })

    await client.send(
      new SearchTextCommand({
        QueryText: 'x',
        BiasPosition: [151.21536789, -33.85681234],
      }),
    )

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies[0].BiasPosition).toEqual([151.215, -33.857])
    expect(bodies[1].BiasPosition).toEqual([151.21537, -33.85681])
  })
})
