import ClientOAuth2 from 'client-oauth2'
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
 * import { TokenProvider } from '@chaosity/location-client'
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
  private oauth2Client: ClientOAuth2
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
    this.oauth2Client = new ClientOAuth2({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      accessTokenUri: `${config.apiUrl}/auth/token`,
    })
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
      const token = await this.oauth2Client.credentials.getToken()
      this.cachedToken = token.accessToken

      // Use expires_in from OAuth2 response (standard)
      const expiresIn = token.data?.expires_in || 900 // Default 15 minutes
      this.cachedExpiresAt = Date.now() + (expiresIn * 1000)

      log('Token acquired successfully (expires in %ds)', expiresIn)
      return {
        success: true,
        token: this.cachedToken,
        expiresAt: this.cachedExpiresAt
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
