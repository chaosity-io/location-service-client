import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocationServiceException } from '../src/errors/LocationServiceException'
import {
  fetchMapStyle,
  fetchStaticMap,
  refreshTokenOnUnauthorized,
} from '../src/index'

/**
 * #72 — after a 401, the map helpers can get a new token.
 *
 * `fetchMapStyle` and `fetchStaticMap` took a synchronous `getToken` and
 * nothing else, and MapLibre fetches tiles through `createTransformRequest`,
 * which never sees a response. So when the API refused the token a page held
 * before its `exp` (a rotated secret, measured), the map stayed broken until
 * a reload. The helpers now take `{ getToken, refreshToken }` and retry once
 * with a different token, and `refreshTokenOnUnauthorized` does the same for
 * the tiles MapLibre fetches itself. A bare `getToken` behaves as it did.
 */

const API = 'https://api.example.test'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const refused = () =>
  json(401, {
    code: 'UnauthorizedException',
    message: 'Missing, malformed, expired or revoked credentials.',
  })
const style = () => json(200, { version: 8, sources: {}, layers: [] })

let fetchMock: ReturnType<typeof vi.fn>
const auth = (call: number) =>
  new Headers(fetchMock.mock.calls[call]![1].headers).get('Authorization')

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchMapStyle asks refreshToken once after a 401 (#72)', () => {
  it('retries with the replacement and resolves the style', async () => {
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(style())
    const refreshToken = vi.fn(async () => 'new-token')

    await expect(
      fetchMapStyle(API, 'Standard', {
        getToken: () => 'old-token',
        refreshToken,
      }),
    ).resolves.toMatchObject({ version: 8 })

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(auth(0)).toBe('Bearer old-token')
    expect(auth(1)).toBe('Bearer new-token')
  })

  it('does not send the same token again: the 401 stands', async () => {
    fetchMock.mockResolvedValue(refused())

    const err = await fetchMapStyle(API, 'Standard', {
      getToken: () => 'old-token',
      refreshToken: async () => 'old-token',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(LocationServiceException)
    expect(err.statusCode).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects with refreshToken's own failure", async () => {
    fetchMock.mockResolvedValue(refused())
    const throttled = new LocationServiceException({
      code: 'RateLimitExceededException',
      message: 'Request rate exceeded. Retry shortly.',
      statusCode: 429,
      retryAfterMs: 1_000,
    })

    await expect(
      fetchMapStyle(API, 'Standard', {
        getToken: () => 'old-token',
        refreshToken: async () => {
          throw throttled
        },
      }),
    ).rejects.toBe(throttled)
  })

  it('never asks on a 403: a new token cannot fix it', async () => {
    fetchMock.mockResolvedValue(
      json(403, { code: 'ForbiddenException', message: 'Forbidden' }),
    )
    const refreshToken = vi.fn(async () => 'new-token')

    await expect(
      fetchMapStyle(API, 'Standard', {
        getToken: () => 'old-token',
        refreshToken,
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it('remembers a token refreshToken could not replace, across calls with the same tokens (#38)', async () => {
    fetchMock.mockResolvedValue(refused())
    const refreshToken = vi.fn(async () => 'old-token')
    const tokens = { getToken: () => 'old-token', refreshToken }

    await fetchMapStyle(API, 'Standard', tokens).catch(() => {})
    const err = await fetchMapStyle(API, 'Standard', tokens).catch((e) => e)

    expect(err.statusCode).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refreshToken).toHaveBeenCalledTimes(1)
  })

  it("holds the refreshToken wait to the caller's signal (#62)", async () => {
    fetchMock.mockResolvedValue(refused())
    const controller = new AbortController()
    const start = Date.now()
    setTimeout(() => controller.abort(), 50)

    const err = await fetchMapStyle(
      API,
      'Standard',
      {
        getToken: () => 'old-token',
        refreshToken: () => new Promise<string>(() => {}),
      },
      {},
      { signal: controller.signal },
    ).catch((e) => e)

    expect(err.code).toBe('AbortedException')
    expect(Date.now() - start).toBeLessThan(150)
  })

  it('holds the refreshToken wait to the overall budget (#62)', async () => {
    fetchMock.mockResolvedValue(refused())

    const err = await fetchMapStyle(
      API,
      'Standard',
      {
        getToken: () => 'old-token',
        refreshToken: () => new Promise<string>(() => {}),
      },
      {},
      { overallTimeoutMs: 100 },
    ).catch((e) => e)

    expect(err.code).toBe('TimeoutException')
  })

  it('behaves as before with a bare getToken: one request, the 401', async () => {
    fetchMock.mockResolvedValue(refused())

    await expect(
      fetchMapStyle(API, 'Standard', () => 'old-token'),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('fetchStaticMap asks refreshToken once after a 401 (#72)', () => {
  it('retries with the replacement and resolves the image', async () => {
    fetchMock.mockResolvedValueOnce(refused()).mockResolvedValueOnce(
      new Response(new Blob(['png']), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    )
    const refreshToken = vi.fn(async () => 'new-token')

    const blob = await fetchStaticMap(
      API,
      { width: 64, height: 64, center: [151.2, -33.8], zoom: 10 },
      { getToken: () => 'old-token', refreshToken },
    )

    expect(blob).toBeInstanceOf(Blob)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(auth(1)).toBe('Bearer new-token')
  })

  it('holds the refreshToken wait to the overall budget (#62)', async () => {
    fetchMock.mockResolvedValue(refused())

    const err = await fetchStaticMap(
      API,
      { width: 64, height: 64, center: [151.2, -33.8], zoom: 10 },
      {
        getToken: () => 'old-token',
        refreshToken: () => new Promise<string>(() => {}),
      },
      { overallTimeoutMs: 100 },
    ).catch((e) => e)

    expect(err.code).toBe('TimeoutException')
  })
})

/** A MapLibre map, as far as the helper touches it. */
const fakeMap = () => {
  const handlers = new Set<(e: unknown) => void>()
  return {
    on: vi.fn((type: string, handler: (e: unknown) => void) => {
      if (type === 'error') handlers.add(handler)
    }),
    off: vi.fn((type: string, handler: (e: unknown) => void) => {
      if (type === 'error') handlers.delete(handler)
    }),
    refreshTiles: vi.fn(),
    emit: (e: unknown) => handlers.forEach((h) => h(e)),
    listening: () => handlers.size,
  }
}
/** A refused tile, as MapLibre fires it: the tile's coordinates in its url. */
const tileError = (status: number, url: string, sourceId = 'vector') => {
  const [z, x, y] = url.split('/').slice(-3).map(Number)
  return {
    error: Object.assign(new Error(`AJAXError: ${status}`), { status, url }),
    sourceId,
    tile: { tileID: { canonical: { x, y, z } } },
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('refreshTokenOnUnauthorized: tiles MapLibre fetches itself (#72)', () => {
  it('asks once for a burst of refused tiles, then reloads those tiles', async () => {
    const map = fakeMap()
    let inHand = 'old-token'
    let resolve!: (t: string) => void
    const refreshToken = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => inHand,
      refreshToken,
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/5`, 'raster'))
    expect(refreshToken).toHaveBeenCalledTimes(1)

    inHand = 'new-token'
    resolve('new-token')
    await flush()
    expect(map.refreshTiles).toHaveBeenCalledTimes(2)
    expect(map.refreshTiles).toHaveBeenCalledWith('vector', [
      { x: 2, y: 3, z: 1 },
      { x: 2, y: 4, z: 1 },
    ])
    expect(map.refreshTiles).toHaveBeenCalledWith('raster', [
      { x: 2, y: 5, z: 1 },
    ])
  })

  it('reloads the refused tiles by id, never the whole source, and each once', async () => {
    // A whole-source reload leaves MapLibre 6's errored tiles waiting for a
    // load that never comes: measured on a map, they stayed blank.
    const map = fakeMap()
    let inHand = 'old-token'
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => inHand,
      refreshToken: async () => (inHand = 'new-token'),
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/11/1684/1215`))
    map.emit(tileError(401, `${API}/maps/Standard/tiles/11/1684/1215`))
    await flush()

    expect(map.refreshTiles).toHaveBeenCalledTimes(1)
    expect(map.refreshTiles).toHaveBeenCalledWith('vector', [
      { x: 1684, y: 1215, z: 11 },
    ])
  })

  it('replaces the token after a refused glyph, with no tile to reload', async () => {
    const map = fakeMap()
    let inHand = 'old-token'
    const refreshToken = vi.fn(async () => (inHand = 'new-token'))
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => inHand,
      refreshToken,
    })

    map.emit({
      error: Object.assign(new Error('AJAXError: 401'), {
        status: 401,
        url: `${API}/maps/glyphs/Amazon%20Ember%20Regular/0-255.pbf`,
      }),
    })
    await flush()

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(inHand).toBe('new-token')
    expect(map.refreshTiles).not.toHaveBeenCalled()
  })

  it("ignores a 403, and a 401 from any host but the API's", async () => {
    const map = fakeMap()
    const refreshToken = vi.fn(async () => 'new-token')
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => 'old-token',
      refreshToken,
    })

    map.emit(tileError(403, `${API}/maps/Standard/tiles/1/2/3`))
    map.emit(tileError(401, 'https://api.example.test.evil.test/maps/tiles/1'))
    map.emit({ error: new Error('style is not done loading') })
    await flush()

    expect(refreshToken).not.toHaveBeenCalled()
    expect(map.refreshTiles).not.toHaveBeenCalled()
  })

  it('reloads nothing when refreshToken hands back the token refused', async () => {
    const map = fakeMap()
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => 'old-token',
      refreshToken: async () => 'old-token',
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
    await flush()

    expect(map.refreshTiles).not.toHaveBeenCalled()
  })

  it('does not ask again while a refresh failure asks it to wait', async () => {
    const map = fakeMap()
    const refreshToken = vi.fn(async () => {
      throw new LocationServiceException({
        code: 'RateLimitExceededException',
        message: 'Request rate exceeded. Retry shortly.',
        statusCode: 429,
        retryAfterMs: 60_000,
      })
    })
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => 'old-token',
      refreshToken,
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
    await flush()
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
    await flush()

    expect(refreshToken).toHaveBeenCalledTimes(1)
  })

  it("reloads nothing when refreshToken's token never reaches getToken: the reload would carry the refused one", async () => {
    const map = fakeMap()
    const refreshToken = vi.fn(async () => 'new-token')
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => 'old-token',
      refreshToken,
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
    await flush()
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
    await flush()

    expect(map.refreshTiles).not.toHaveBeenCalled()
    expect(refreshToken).toHaveBeenCalledTimes(1)
  })

  it('reloads with the token getToken holds when refreshToken resolves nothing', async () => {
    const map = fakeMap()
    let inHand = 'old-token'
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => inHand,
      refreshToken: async () => {
        inHand = 'new-token'
        return undefined
      },
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
    await flush()

    expect(map.refreshTiles).toHaveBeenCalledWith('vector', [
      { x: 2, y: 3, z: 1 },
    ])
  })

  it('asks no more after refreshToken hands back the refused token, until the token in hand changes', async () => {
    const map = fakeMap()
    let inHand = 'old-token'
    const refreshToken = vi.fn(async () => inHand)
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => inHand,
      refreshToken,
    })

    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
    await flush()
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
    await flush()
    expect(refreshToken).toHaveBeenCalledTimes(1)

    inHand = 'other-token'
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/5`))
    await flush()
    expect(refreshToken).toHaveBeenCalledTimes(2)
  })

  it('asks no more when the API refuses the token refreshToken brought too, until the hold lapses', async () => {
    // An API that refuses every token — a map pointed at another API than its
    // tokens are for — refused each reload in its turn, and each refusal asked
    // for another token: a mint and a reload several times a second.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const map = fakeMap()
      let minted = 0
      let inHand = 'token-0'
      const refreshToken = vi.fn(async () => (inHand = `token-${++minted}`))
      const tokens = { getToken: () => inHand, refreshToken }
      refreshTokenOnUnauthorized(map, API, tokens)

      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
      await flush()
      // The tile reloaded with the new token, refused in its turn.
      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
      await flush()
      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
      await flush()
      expect(refreshToken).toHaveBeenCalledTimes(1)
      expect(map.refreshTiles).toHaveBeenCalledTimes(1)

      // Held as the send paths hold it, and shared with them.
      fetchMock.mockResolvedValue(refused())
      const err = await fetchMapStyle(API, 'Standard', tokens).catch((e) => e)
      expect(err.statusCode).toBe(401)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(refreshToken).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 30_001)
      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/6`))
      await flush()
      expect(refreshToken).toHaveBeenCalledTimes(2)
      // Every tile refused meanwhile is reloaded, the one that set the hold too.
      expect(map.refreshTiles).toHaveBeenLastCalledWith('vector', [
        { x: 2, y: 3, z: 1 },
        { x: 2, y: 4, z: 1 },
        { x: 2, y: 6, z: 1 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks once for two maps handed the same tokens, when the API refuses every token', async () => {
    // Each helper kept its own note of the token a refresh brought, so each
    // took the other's as news and asked again: as many asks as refusals.
    const [a, b] = [fakeMap(), fakeMap()]
    let minted = 0
    let inHand = 'token-0'
    const refreshToken = vi.fn(async () => (inHand = `token-${++minted}`))
    const tokens = { getToken: () => inHand, refreshToken }
    refreshTokenOnUnauthorized(a, API, tokens)
    refreshTokenOnUnauthorized(b, API, tokens)

    for (let round = 0; round < 6; round++) {
      a.emit(tileError(401, `${API}/maps/Standard/tiles/3/1/1`))
      await flush()
      b.emit(tileError(401, `${API}/maps/Standard/tiles/3/1/2`))
      await flush()
    }

    expect(refreshToken).toHaveBeenCalledTimes(1)
  })

  it('reloads a tile refused late, with the token before, and holds nothing', async () => {
    // A tile requested with the old token whose 401 lands after the refresh
    // settled looks like the new token refused. Holding the new token for it
    // left that tile empty and refused the style fetch for 30 seconds.
    const map = fakeMap()
    let inHand = 'token-0'
    const refreshToken = vi.fn(async () => (inHand = 'token-1'))
    const tokens = { getToken: () => inHand, refreshToken }
    refreshTokenOnUnauthorized(map, API, tokens)

    map.emit(tileError(401, `${API}/maps/Standard/tiles/3/1/1`))
    await flush()
    map.emit(tileError(401, `${API}/maps/Standard/tiles/3/1/2`))
    await flush()

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(map.refreshTiles).toHaveBeenLastCalledWith('vector', [
      { x: 1, y: 2, z: 3 },
    ])
    fetchMock.mockResolvedValueOnce(style())
    await expect(fetchMapStyle(API, 'Standard', tokens)).resolves.toMatchObject(
      { version: 8 },
    )
    expect(auth(0)).toBe('Bearer token-1')
  })

  it('asks nothing for a glyph refused while the token the refresh brought is in hand, and holds nothing', async () => {
    const map = fakeMap()
    let inHand = 'token-0'
    const refreshToken = vi.fn(async () => (inHand = 'token-1'))
    const tokens = { getToken: () => inHand, refreshToken }
    refreshTokenOnUnauthorized(map, API, tokens)

    map.emit(tileError(401, `${API}/maps/Standard/tiles/3/1/1`))
    await flush()
    map.emit({
      error: Object.assign(new Error('AJAXError: 401'), {
        status: 401,
        url: `${API}/maps/glyphs/Amazon%20Ember%20Regular/0-255.pbf`,
      }),
    })
    await flush()

    expect(refreshToken).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValueOnce(style())
    await expect(fetchMapStyle(API, 'Standard', tokens)).resolves.toMatchObject(
      { version: 8 },
    )
  })

  it('replaces a token refreshToken brought when the API refuses it after the hold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const map = fakeMap()
      let minted = 0
      let inHand = 'token-0'
      const refreshToken = vi.fn(async () => (inHand = `token-${++minted}`))
      refreshTokenOnUnauthorized(map, API, {
        getToken: () => inHand,
        refreshToken,
      })

      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`))
      await flush()
      // The reload was served; a while later the new token is revoked too.
      vi.setSystemTime(Date.now() + 30_001)
      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
      await flush()

      expect(refreshToken).toHaveBeenCalledTimes(2)
      expect(map.refreshTiles).toHaveBeenLastCalledWith('vector', [
        { x: 2, y: 4, z: 1 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a refreshToken that throws out of the map, and asks again on the next 401', async () => {
    const map = fakeMap()
    const refreshToken = vi.fn((): Promise<string> => {
      throw new TypeError('fetch failed')
    })
    refreshTokenOnUnauthorized(map, API, {
      getToken: () => 'old-token',
      refreshToken,
    })

    expect(() =>
      map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/3`)),
    ).not.toThrow()
    await flush()
    map.emit(tileError(401, `${API}/maps/Standard/tiles/1/2/4`))
    await flush()

    expect(refreshToken).toHaveBeenCalledTimes(2)
  })

  it('stops listening when its return is called', () => {
    const map = fakeMap()
    const stop = refreshTokenOnUnauthorized(map, API, {
      getToken: () => 'old-token',
      refreshToken: async () => 'new-token',
    })
    expect(map.listening()).toBe(1)

    stop()
    expect(map.listening()).toBe(0)
  })
})
