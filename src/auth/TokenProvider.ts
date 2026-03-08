import debug from 'debug'

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
        'Use @chaosity/location-client-react for browser usage.'
      )
    }

    log('Initializing TokenProvider for %s', config.apiUrl)
    this.config = config
  }

  async getToken(forceRefresh = false): Promise<TokenResponse> {
    if (!forceRefresh && this.cachedToken && !this.isExpired()) {
      const expiresIn = this.cachedExpiresAt ? Math.floor((this.cachedExpiresAt - Date.now()) / 1000) : 'unknown'
      log('Using cached token (expires in %ds)', expiresIn)
      return {
        success: true,
        token: this.cachedToken,
        expiresAt: this.cachedExpiresAt
      }
    }

    // If token fetch is already in progress, wait for it
    if (this.tokenPromise) {
      log('Token fetch in progress, waiting for existing request...')
      return this.tokenPromise
    }

    // Start new token fetch
    const reason = forceRefresh ? 'forced refresh' : (this.cachedToken ? 'token expired' : 'no cached token')
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

  private async fetchToken(): Promise<TokenResponse> {
    try {
      const { clientId, clientSecret, apiUrl } = this.config
      const credentials = btoa(`${clientId}:${clientSecret}`)

      const response = await fetch(`${apiUrl}/auth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      })

      if (!response.ok) {
        const errorText = await response.text()
        let errorMessage = `Token request failed: ${response.statusText}`
        try {
          const errorData = JSON.parse(errorText)
          if (errorData.error_description) errorMessage = errorData.error_description
          else if (errorData.error) errorMessage = errorData.error
        } catch { /* use statusText */ }
        throw new Error(errorMessage)
      }

      const data = await response.json()
      this.cachedToken = data.access_token

      // Prefer absolute expires_at (ms) from response, fall back to expires_in (seconds)
      this.cachedExpiresAt = data.expires_at ?? (Date.now() + ((data.expires_in ?? 900) * 1000))

      const expiresInSec = Math.floor((this.cachedExpiresAt! - Date.now()) / 1000)
      log('Token acquired successfully (expires in %ds)', expiresInSec)
      return {
        success: true,
        token: this.cachedToken,
        expiresAt: this.cachedExpiresAt,
      }
    } catch (error) {
      log('Token acquisition failed: %s', error instanceof Error ? error.message : 'Unknown error')
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get token',
      }
    }
  }

  private isExpired(bufferSeconds = 60): boolean {
    if (!this.cachedExpiresAt) return true
    return Date.now() >= (this.cachedExpiresAt - bufferSeconds * 1000)
  }

  clearCache(): void {
    this.cachedToken = undefined
    this.cachedExpiresAt = undefined
  }
}
