import { SearchTextCommand } from '@aws-sdk/client-geo-places'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOKEN_REFUSAL_HOLD_MS } from '../src/auth/tokenHold'
import { GeoPlacesClient } from '../src/client/GeoPlacesClient'
import { LocationServiceException } from '../src/errors/LocationServiceException'

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
 * request is a second round trip for the same answer.
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

  it('retries with the same body, at the caller precision', async () => {
    // This test used to prove the body was re-derived per attempt, because it
    // was shaped from a token claim. Nothing in the body comes from the token
    // any more (#51), so what matters is the other half: a retry must not be
    // where the caller's coordinate quietly changes.
    rejectThenAccept()
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'stale',
      refreshToken: async () => 'fresh',
    })

    await client.send(
      new SearchTextCommand({
        QueryText: 'x',
        BiasPosition: [151.21536789, -33.85681234],
      }),
    )

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body.BiasPosition).toEqual([151.21536789, -33.85681234])
    }
  })
})

describe('a client with no token at all never sends Bearer undefined (#37)', () => {
  /**
   * The 401 self-heal above cannot cover this: it needs a request to have been
   * REJECTED first. So a client whose token source has not produced one yet
   * spent a whole round trip on `Authorization: Bearer undefined`, to be told
   * something it already knew.
   */
  it('refuses rather than sending, when nothing can supply a token', async () => {
    const client = new GeoPlacesClient({ apiUrl: API })

    const err = await client
      .send(new SearchTextCommand({ QueryText: 'x' }))
      .catch((e) => e)

    expect(err.code).toBe('InvalidCredentialsException')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks refreshToken first, and sends once it has one', async () => {
    // The provider case: `getToken` is synchronous and has nothing yet, but the
    // async source can mint one. That is a request worth making.
    const refreshToken = vi.fn().mockResolvedValue('minted')
    const client = new GeoPlacesClient({
      apiUrl: API,
      getToken: () => undefined,
      refreshToken,
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(authHeaders()).toEqual(['Bearer minted'])
  })

  it('treats an empty getToken the same as an absent one', async () => {
    // `??` let `''` through the coalesce and then failed the check below it, so
    // `getToken: () => undefined` reached refreshToken and `getToken: () => ''`
    // did not. Nobody means to draw that distinction.
    const refreshToken = vi.fn().mockResolvedValue('minted')
    const client = new GeoPlacesClient({
      apiUrl: API,
      getToken: () => '',
      refreshToken,
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(authHeaders()).toEqual(['Bearer minted'])
  })

  it('refuses when refreshToken cannot supply one either', async () => {
    const client = new GeoPlacesClient({
      apiUrl: API,
      refreshToken: async () => undefined,
    })

    const err = await client
      .send(new SearchTextCommand({ QueryText: 'x' }))
      .catch((e) => e)

    expect(err.code).toBe('InvalidCredentialsException')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a refused token is not re-sent, nor its refresh re-asked, on every send (#38)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  const refusedCredentials = () =>
    new LocationServiceException({
      code: 'InvalidCredentialsException',
      message: 'Invalid credentials',
      statusCode: 401,
    })

  it('asks a rejecting refreshToken once per hold, not once per send', async () => {
    // A rotated secret: the data route refuses the token, and the refresh —
    // under @chaosity/location-client-react, the application's own token
    // route, still holding the old secret — is refused too. Each send used to
    // repeat both.
    fetchMock.mockImplementation(async () => unauthorized())
    const refreshToken = vi.fn(async () => {
      throw refusedCredentials()
    })
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken,
    })

    for (let i = 0; i < 5; i++) {
      await expect(
        client.send(new SearchTextCommand({ QueryText: 'x' })),
      ).rejects.toThrow('Invalid credentials')
    }
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(TOKEN_REFUSAL_HOLD_MS)
    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('Invalid credentials')
    expect(refreshToken).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not re-send a token the API refused when the refresh has nothing new', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken: async () => 'refused',
    })

    for (let i = 0; i < 3; i++) {
      await expect(
        client.send(new SearchTextCommand({ QueryText: 'x' })),
      ).rejects.toMatchObject({ statusCode: 401 })
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ends the hold at once when getToken yields a different token', async () => {
    let current = 'refused'
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer fresh'
        ? ok()
        : unauthorized(),
    )
    const client = new GeoPlacesClient({
      apiUrl: API,
      getToken: () => current,
      refreshToken: async () => {
        throw refusedCredentials()
      },
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('Invalid credentials')
    current = 'fresh'
    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })
  })

  it('asks again after a refresh that failed for a reason that says nothing, without re-sending the refused token', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const refreshToken = vi.fn(async (): Promise<string> => {
      throw new TypeError('fetch failed')
    })
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken,
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('fetch failed')
    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('fetch failed')
    expect(refreshToken).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not re-send a refused token when the refresh is a Server Action that rejects without fields', async () => {
    // Under @chaosity/location-client-react, the refresh is the application's
    // `getConfig`, and a Server Action's error reaches the browser as a plain
    // Error: its status and code do not cross. So nothing says how long to
    // wait, and each send asks the provider again — which answers from its
    // own back-off — but the token the API refused is not sent again.
    fetchMock.mockImplementation(async () => unauthorized())
    const refreshToken = vi.fn(async (): Promise<string> => {
      throw new Error('An error occurred in the Server Components render.')
    })
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken,
    })

    for (let i = 0; i < 3; i++) {
      await expect(
        client.send(new SearchTextCommand({ QueryText: 'x' })),
      ).rejects.toThrow('Server Components render')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refreshToken).toHaveBeenCalledTimes(3)
  })

  it('re-sends the refused token once per hold while the refresh keeps failing untyped', async () => {
    // The hold has an end. Remembered again on every send, it slid forward for
    // as long as the refresh kept failing, and an application made active
    // again was never noticed.
    fetchMock.mockImplementation(async () => unauthorized())
    const refreshToken = vi.fn(async (): Promise<string> => {
      throw new TypeError('fetch failed')
    })
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken,
    })

    // Sends two-thirds of a hold apart: a hold that slid forward on each one
    // would still stand at the third.
    const step = (TOKEN_REFUSAL_HOLD_MS * 2) / 3
    for (let i = 0; i < 2; i++) {
      await expect(
        client.send(new SearchTextCommand({ QueryText: 'x' })),
      ).rejects.toThrow('fetch failed')
      vi.advanceTimersByTime(step)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('fetch failed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(refreshToken).toHaveBeenCalledTimes(3)
  })

  it('keeps the original refusal while the refresh fails untyped, not a chain of replays', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    let asked = 0
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken: async () => {
        asked += 1
        if (asked <= 3) throw new TypeError('fetch failed')
        return 'refused'
      },
    })

    for (let i = 0; i < 3; i++) {
      await expect(
        client.send(new SearchTextCommand({ QueryText: 'x' })),
      ).rejects.toThrow('fetch failed')
    }
    // The refresh now hands back the refused token: the held 401 is thrown.
    const err = await client
      .send(new SearchTextCommand({ QueryText: 'x' }))
      .catch((e) => e)
    expect(err.statusCode).toBe(401)
    expect((err.cause as LocationServiceException).cause).toBeUndefined()
  })

  it('sends the replacement straight away when the refresh recovers, without the refused token first', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer fresh'
        ? ok()
        : unauthorized(),
    )
    let calls = 0
    const client = new GeoPlacesClient({
      apiUrl: API,
      token: 'refused',
      refreshToken: async () => {
        calls += 1
        if (calls === 1) throw new TypeError('fetch failed')
        return 'fresh'
      },
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('fetch failed')
    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })
    expect(authHeaders()).toEqual(['Bearer refused', 'Bearer fresh'])
  })
})

describe('a client with no token holds a refusing refreshToken too (#38)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('asks refreshToken once per hold before the first send, not once per send', async () => {
    // The pre-flight: nothing in hand, so refreshToken is asked before a send.
    // A refusal there used to be asked again on every send.
    const refreshToken = vi.fn(async (): Promise<string> => {
      throw new LocationServiceException({
        code: 'InvalidCredentialsException',
        message: 'Invalid credentials',
        statusCode: 401,
      })
    })
    const client = new GeoPlacesClient({ apiUrl: API, refreshToken })

    for (let i = 0; i < 3; i++) {
      await expect(
        client.send(new SearchTextCommand({ QueryText: 'x' })),
      ).rejects.toThrow('Invalid credentials')
    }
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TOKEN_REFUSAL_HOLD_MS)
    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('Invalid credentials')
    expect(refreshToken).toHaveBeenCalledTimes(2)
  })

  it('ends that hold as soon as getToken has a token', async () => {
    const source: { current?: string } = {}
    const client = new GeoPlacesClient({
      apiUrl: API,
      getToken: () => source.current,
      refreshToken: async () => {
        throw new LocationServiceException({
          code: 'InvalidCredentialsException',
          message: 'Invalid credentials',
          statusCode: 401,
        })
      },
    })

    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).rejects.toThrow('Invalid credentials')
    source.current = 'arrived'
    await expect(
      client.send(new SearchTextCommand({ QueryText: 'x' })),
    ).resolves.toEqual({ ResultItems: [] })
  })
})
