import debug from 'debug'
import { LocationServiceException } from '../errors/LocationServiceException.js'
import { requestJson } from '../transport/http.js'
import {
  TOKEN_REFRESH_BUFFER_SECONDS,
  readTokenExpiry,
} from './tokenRefresh.js'

const log = debug('location-client:auth')

export interface TokenResponse {
  success: boolean
  token?: string
  expiresAt?: number
  error?: string
}

export interface TokenProviderConfig {
  apiUrl: string
  clientId: string
  clientSecret: string
}

/**
 * TokenProvider - SERVER-SIDE ONLY
 *
 * ⚠️ WARNING: This class requires client credentials (clientId and clientSecret)
 * and must NEVER be used in browser/client-side code.
 *
 * Use this only in:
 * - Node.js server environments
 * - Next.js Server Actions (marked with 'use server')
 * - Next.js API routes
 * - Backend services
 *
 * For browser usage, use the React provider which receives tokens from server-side code.
 *
 * @example
 * // ✓ Correct: Server-side usage
 * import { TokenProvider } from '@chaosity/location-client/server'
 *
 * const provider = new TokenProvider({
 *   apiUrl: process.env.API_URL!,
 *   clientId: process.env.CLIENT_ID!,
 *   clientSecret: process.env.CLIENT_SECRET!,
 * })
 *
 * @example
 * // ✗ Wrong: Never use in browser code
 * // This would expose your credentials!
 */
export class TokenProvider {
  private config: TokenProviderConfig
  private cachedToken?: string
  private cachedExpiresAt?: number
  private tokenPromise?: Promise<TokenResponse>

  constructor(config: TokenProviderConfig) {
    // Runtime check: prevent usage in browser
    if (typeof window !== 'undefined') {
      throw new Error(
        'TokenProvider cannot be used in browser environments. ' +
          'It requires client credentials that must never be exposed to browsers. ' +
          'Use @chaosity/location-client-react for browser usage.',
      )
    }

    log('Initializing TokenProvider for %s', config.apiUrl)
    this.config = config
  }

  async getToken(forceRefresh = false): Promise<TokenResponse> {
    if (!forceRefresh && this.cachedToken && !this.isExpired()) {
      const expiresIn = this.cachedExpiresAt
        ? Math.floor((this.cachedExpiresAt - Date.now()) / 1000)
        : 'unknown'
      log('Using cached token (expires in %ds)', expiresIn)
      return {
        success: true,
        token: this.cachedToken,
        expiresAt: this.cachedExpiresAt,
      }
    }

    // If token fetch is already in progress, wait for it
    if (this.tokenPromise) {
      log('Token fetch in progress, waiting for existing request...')
      return this.tokenPromise
    }

    // Start new token fetch
    const reason = forceRefresh
      ? 'forced refresh'
      : this.cachedToken
        ? 'token expired'
        : 'no cached token'
    log('Refreshing token (%s) from %s', reason, this.config.apiUrl)

    this.tokenPromise = this.fetchToken()

    try {
      const result = await this.tokenPromise
      return result
    } finally {
      // Clear promise after completion (success or failure)
      this.tokenPromise = undefined
    }
  }

  /**
   * Fetch a token, distinguishing transient failure from terminal (#9).
   *
   * This used to collapse every non-200 into `new Error(message)`: no status,
   * no OAuth `error`, no `Retry-After`. So `503 temporarily_unavailable` — which
   * the API returns when its config store is unreachable — was indistinguishable
   * from `401 unauthorized`, and a customer whose credentials were perfectly
   * good was told to go and check them.
   *
   * The shared transport now does the classifying: it retries 503/429/network
   * honouring `Retry-After`, never retries 401/400, and throws a typed
   * LocationServiceException either way. A failure REJECTS rather than resolving
   * with `success: false`, so a stale token can never be used by accident.
   */
  private async fetchToken(): Promise<TokenResponse> {
    const { clientId, clientSecret, apiUrl } = this.config
    const credentials = btoa(`${clientId}:${clientSecret}`)

    const data = await requestJson<{
      access_token: string
      expires_at?: number
      expires_in?: number
    }>(
      `${apiUrl}/auth/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
        }).toString(),
      },
      { retry: { maxAttempts: 3 } },
    )

    if (!data.access_token) {
      throw new LocationServiceException({
        code: 'InvalidCredentialsException',
        message: 'Token endpoint returned no access_token',
        details: { source: 'client' },
      })
    }

    this.cachedToken = data.access_token
    // The token's own `exp` claim first — it is the only value that cannot
    // disagree with what the API will actually accept. `expires_at` and
    // `expires_in` are what the response CLAIMS, and are kept as fallbacks.
    this.cachedExpiresAt =
      readTokenExpiry(data.access_token) ??
      data.expires_at ??
      Date.now() + (data.expires_in ?? 900) * 1000

    log(
      'Token acquired successfully (expires in %ds)',
      Math.floor((this.cachedExpiresAt - Date.now()) / 1000),
    )
    return {
      success: true,
      token: this.cachedToken,
      expiresAt: this.cachedExpiresAt,
    }
  }

  private isExpired(bufferSeconds = TOKEN_REFRESH_BUFFER_SECONDS): boolean {
    if (!this.cachedExpiresAt) return true
    return Date.now() >= this.cachedExpiresAt - bufferSeconds * 1000
  }

  clearCache(): void {
    this.cachedToken = undefined
    this.cachedExpiresAt = undefined
  }
}
