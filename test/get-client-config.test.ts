import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * getClientConfig was at 0% — 163 lines that read credentials from the
 * environment and own a PROCESS-WIDE singleton (#6 / T35).
 *
 * The property worth the most here is the singleton key. It includes a hash of
 * the client secret, because keying on `apiUrl:clientId` alone meant rotating a
 * secret while keeping the same clientId left the process reusing a provider
 * built on the OLD secret — so the rotation appeared to do nothing until a
 * restart (#5). That failure is invisible: nothing errors, the old token keeps
 * working until it expires, and then everything 401s for reasons nobody can
 * trace back to the rotation.
 *
 * The module holds that singleton at module scope, so every test resets the
 * registry and re-imports rather than sharing state with its neighbours.
 */

const ENV_KEYS = [
  'LOCATION_API_URL',
  'LOCATION_SERVICE_API_URL',
  'LOCATION_CLIENT_ID',
  'LOCATION_SERVICE_CLIENT_ID',
  'LOCATION_CLIENT_SECRET',
  'LOCATION_SERVICE_CLIENT_SECRET',
]

const jwt = (secs: number) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + secs })}.s`
}

const tokenOk = () =>
  new Response(JSON.stringify({ access_token: jwt(900) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const tokenErr = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>
let saved: Record<string, string | undefined>

/**
 * Fresh module registry, so the singleton starts empty for every test.
 *
 * The exception class comes from the SAME graph deliberately. `vi.resetModules`
 * rebuilds the whole graph, so a statically imported LocationServiceException is
 * a different class object from the one this copy of the code throws — and
 * `instanceof` compares identity, so it fails with the baffling
 * "expected LocationServiceException to be an instance of
 * LocationServiceException".
 */
const load = async () => {
  vi.resetModules()
  const [{ getClientConfig }, { LocationServiceException }] = await Promise.all(
    [
      import('../src/server/getClientConfig'),
      import('../src/errors/LocationServiceException'),
    ],
  )
  return { getClientConfig, LocationServiceException }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  fetchMock = vi.fn().mockImplementation(async () => tokenOk())
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('where the configuration comes from', () => {
  it('reads the LOCATION_* environment variables', async () => {
    process.env.LOCATION_API_URL = 'https://env.test'
    process.env.LOCATION_CLIENT_ID = 'env-id'
    process.env.LOCATION_CLIENT_SECRET = 'env-secret'

    const { getClientConfig } = await load()
    await expect(getClientConfig()).resolves.toMatchObject({
      apiUrl: 'https://env.test',
    })
  })

  it('accepts the LOCATION_SERVICE_* spellings too', async () => {
    process.env.LOCATION_SERVICE_API_URL = 'https://alt.test'
    process.env.LOCATION_SERVICE_CLIENT_ID = 'alt-id'
    process.env.LOCATION_SERVICE_CLIENT_SECRET = 'alt-secret'

    const { getClientConfig } = await load()
    await expect(getClientConfig()).resolves.toMatchObject({
      apiUrl: 'https://alt.test',
    })
  })

  it('lets an explicit argument beat the environment', async () => {
    process.env.LOCATION_API_URL = 'https://env.test'
    process.env.LOCATION_CLIENT_ID = 'env-id'
    process.env.LOCATION_CLIENT_SECRET = 'env-secret'

    const { getClientConfig } = await load()
    await expect(
      getClientConfig({ apiUrl: 'https://explicit.test' }),
    ).resolves.toMatchObject({ apiUrl: 'https://explicit.test' })
  })

  it('names the variables to set when configuration is missing', async () => {
    const { getClientConfig } = await load()
    await expect(getClientConfig()).rejects.toThrow(
      /LOCATION_API_URL, LOCATION_CLIENT_ID, LOCATION_CLIENT_SECRET/,
    )
  })

  it('refuses a partial configuration rather than half-working', async () => {
    process.env.LOCATION_API_URL = 'https://env.test'
    process.env.LOCATION_CLIENT_ID = 'env-id'
    // no secret

    const { getClientConfig } = await load()
    await expect(getClientConfig()).rejects.toThrow(/Missing required/)
  })
})

describe('the singleton key includes the SECRET (#5 / T32)', () => {
  const base = { apiUrl: 'https://api.test', clientId: 'id-1' }

  it('reuses one provider for an unchanged configuration', async () => {
    const { getClientConfig } = await load()

    await getClientConfig({ ...base, clientSecret: 'secret-A' })
    await getClientConfig({ ...base, clientSecret: 'secret-A' })

    // Second call is served from the provider's own token cache.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('builds a NEW provider when only the secret changes', async () => {
    // The bug: keyed on apiUrl:clientId alone, a rotated secret kept the old
    // provider — and its cached token — alive, so the rotation did nothing at
    // all until the process restarted.
    const { getClientConfig } = await load()

    await getClientConfig({ ...base, clientSecret: 'secret-A' })
    await getClientConfig({ ...base, clientSecret: 'secret-B' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondAuth = fetchMock.mock.calls[1][1].headers.Authorization
    expect(secondAuth).toBe(`Basic ${btoa('id-1:secret-B')}`)
  })

  it('builds a new provider when the API url changes', async () => {
    const { getClientConfig } = await load()

    await getClientConfig({ ...base, clientSecret: 's' })
    await getClientConfig({
      ...base,
      apiUrl: 'https://other.test',
      clientSecret: 's',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('builds a new provider when the client id changes', async () => {
    const { getClientConfig } = await load()

    await getClientConfig({ ...base, clientSecret: 's' })
    await getClientConfig({ ...base, clientId: 'id-2', clientSecret: 's' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('what it says when authentication fails', () => {
  const cfg = {
    apiUrl: 'https://api.test',
    clientId: 'id-1',
    clientSecret: 'nope',
  }

  it('turns a 401 into advice that names the client id and the variables', async () => {
    fetchMock.mockImplementation(async () =>
      tokenErr(401, { error: 'unauthorized' }),
    )
    const { getClientConfig } = await load()

    await expect(getClientConfig(cfg)).rejects.toMatchObject({
      code: 'InvalidCredentialsException',
    })
    await expect(getClientConfig(cfg)).rejects.toThrow(
      /LOCATION_CLIENT_ID and LOCATION_CLIENT_SECRET/,
    )
  })

  it('does NOT call a store outage a credentials problem (#10)', async () => {
    // The API answers 503 when its config store is unreachable. Reporting that
    // as bad credentials sends the customer to check something that is fine.
    fetchMock.mockImplementation(async () =>
      tokenErr(503, { error: 'temporarily_unavailable' }),
    )
    const { getClientConfig, LocationServiceException } = await load()

    const err = await getClientConfig(cfg).catch((e) => e)
    expect(err).toBeInstanceOf(LocationServiceException)
    expect(err.code).not.toBe('InvalidCredentialsException')
  })

  it('keeps the original failure as the cause', async () => {
    fetchMock.mockImplementation(async () =>
      tokenErr(401, { error: 'unauthorized' }),
    )
    const { getClientConfig, LocationServiceException } = await load()

    const err = await getClientConfig(cfg).catch((e) => e)
    expect(err.cause).toBeInstanceOf(LocationServiceException)
  })
})

describe('what it returns', () => {
  it('hands back the url, the token and its expiry', async () => {
    const { getClientConfig } = await load()

    const cfg = await getClientConfig({
      apiUrl: 'https://api.test',
      clientId: 'id',
      clientSecret: 's',
    })

    expect(cfg.apiUrl).toBe('https://api.test')
    expect(typeof cfg.token).toBe('string')
    expect(cfg.expiresAt).toBeGreaterThan(Date.now())
  })

  it('never returns the secret it was given', async () => {
    const { getClientConfig } = await load()

    const cfg = await getClientConfig({
      apiUrl: 'https://api.test',
      clientId: 'id',
      clientSecret: 'super-secret-value',
    })

    expect(JSON.stringify(cfg)).not.toContain('super-secret-value')
  })
})
