import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocationServiceException, fetchMapStyle } from '../src/index'

/**
 * A failed style request keeps the API's message.
 *
 * `fetchMapStyle` used to throw `Failed to fetch map style: 400`, built from the
 * status alone. The body was never read — so the sentence the API had gone to
 * some trouble to forward was discarded two lines before anyone could see it:
 *
 *   API:    400 {"message":"Traffic is not supported for style.", ...}
 *   client: Error: Failed to fetch map style: 400
 *
 * That is the same defect location-service-api#89 fixed on the server, one layer
 * up: a useful message thrown away because the code discriminated on the wrong
 * thing. Found by driving the testbed, not by a test — which is why these exist.
 *
 * NOTE ON THE MOCK: `mockImplementation`, not `mockResolvedValue`. A `Response`
 * body can be consumed once, so a single shared instance makes the second
 * assertion fail with "Body is unusable" from somewhere inside the transport.
 */

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

const call = () =>
  fetchMapStyle('https://api.example.com', 'Satellite', () => 'tok', {
    traffic: 'Congestion',
  })

describe("the API's own message survives", () => {
  it('surfaces the combination error Amazon reports', async () => {
    // Membership is checked locally by the API; COMBINATIONS are Amazon's rule
    // and arrive per request, so this sentence cannot be predicted client-side.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json(400, {
          message: 'Traffic is not supported for style.',
          code: 'ValidationException',
          requestId: 'req-1',
        }),
      ),
    )

    await expect(call()).rejects.toThrow('Traffic is not supported for style.')
  })

  it('arrives as a LocationServiceException, like every other call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json(400, {
          message: 'light is not a supported color scheme for style Standard.',
          code: 'ValidationException',
          requestId: 'req-2',
        }),
      ),
    )

    // Imported from the same module graph as the code under test, or the
    // instanceof check compares two different class objects.
    await expect(call()).rejects.toBeInstanceOf(LocationServiceException)
  })

  it('keeps code, statusCode and requestId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json(400, {
          message: 'Traffic is not supported for style.',
          code: 'ValidationException',
          requestId: 'req-3',
        }),
      ),
    )

    const err = await call().catch(
      (e: unknown) => e as LocationServiceException,
    )
    expect(err.code).toBe('ValidationException')
    expect(err.statusCode).toBe(400)
    expect(err.requestId).toBe('req-3')
  })

  it('handles a 406 from the binary Accept guard', async () => {
    // The descriptor is text and is not gated, but a caller can still reach a
    // 406 through this function if the API ever gates more (api#92).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json(406, {
          message:
            "This endpoint returns application/x-protobuf; send 'Accept: …'",
          code: 'NotAcceptableException',
          requestId: 'req-4',
        }),
      ),
    )

    const err = await call().catch(
      (e: unknown) => e as LocationServiceException,
    )
    expect(err.statusCode).toBe(406)
    expect(err.code).toBe('NotAcceptableException')
    expect(err.message).toContain('application/x-protobuf')
  })
})

describe('a body that is not our envelope still says something useful', () => {
  it('falls back to the raw body when it is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response('<html>502 Bad Gateway</html>', {
            status: 502,
            statusText: 'Bad Gateway',
          }),
      ),
    )

    const err = await call().catch(
      (e: unknown) => e as LocationServiceException,
    )
    expect(err.statusCode).toBe(502)
    expect(err.message).toContain('502 Bad Gateway')
  })

  it('falls back to the status when the body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response('', { status: 401, statusText: 'Unauthorized' }),
        ),
    )

    const err = await call().catch(
      (e: unknown) => e as LocationServiceException,
    )
    expect(err.statusCode).toBe(401)
    expect(err.message).toContain('Unauthorized')
  })
})

describe('a successful style is still returned untouched', () => {
  it('parses and returns the descriptor', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          json(200, { version: 8, sources: {}, layers: [] }),
        ),
    )

    const style = await fetchMapStyle(
      'https://api.example.com',
      'Standard',
      () => 'tok',
    )
    expect(style.version).toBe(8)
  })
})

describe('the style fetch is on the shared transport (#37)', () => {
  /**
   * It used to be a bare `fetch`: no timeout, no retry, no signal, and a
   * network fault escaping as a raw `TypeError` while the identical fault on
   * any other call in the package arrived as `NetworkException`.
   */
  it('refuses without a token rather than sending Bearer undefined', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)

    const err = await fetchMapStyle(
      'https://api.example.com',
      'Standard',
      () => undefined,
    ).catch((e: unknown) => e as LocationServiceException)

    expect(err).toBeInstanceOf(LocationServiceException)
    expect(err.code).toBe('InvalidCredentialsException')
    // Not sent at all: `Bearer undefined` is a request that can only 401 — a
    // round trip spent to be told what the caller already knows.
    expect(spy).not.toHaveBeenCalled()
  })

  it('retries a 503 and returns the descriptor it eventually gets', async () => {
    const spy = vi
      .fn()
      .mockImplementationOnce(async () => json(503, { message: 'later' }))
      .mockImplementationOnce(async () =>
        json(200, { version: 8, sources: {}, layers: [] }),
      )
    vi.stubGlobal('fetch', spy)

    const style = await fetchMapStyle(
      'https://api.example.com',
      'Standard',
      () => 'tok',
    )
    expect(style.version).toBe(8)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('reports a network fault as NetworkException, not a raw TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    )

    const err = await fetchMapStyle(
      'https://api.example.com',
      'Standard',
      () => 'tok',
      {},
      { retry: false },
    ).catch((e: unknown) => e as LocationServiceException)

    expect(err).toBeInstanceOf(LocationServiceException)
    expect(err.code).toBe('NetworkException')
  })

  it('is cancellable, like every other call', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const controller = new AbortController()
    controller.abort()

    const err = await fetchMapStyle(
      'https://api.example.com',
      'Standard',
      () => 'tok',
      {},
      { signal: controller.signal },
    ).catch((e: unknown) => e as LocationServiceException)

    expect(err.code).toBe('AbortedException')
    expect(spy).not.toHaveBeenCalled()
  })
})
