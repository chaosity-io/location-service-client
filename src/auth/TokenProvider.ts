import ClientOAuth2 from 'client-oauth2'
import { decodeJwt } from 'jose'
import debug from 'debug'

const log = debug('location-client:auth')

export interface TokenResponse {
  success: boolean
  token?: string
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
      const exp = this.getTokenExpiry()
      log('Using cached token (expires in %ds)', exp ? Math.floor(exp - Date.now() / 1000) : 'unknown')
      return {
        success: true,
        token: this.cachedToken
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

      const exp = this.getTokenExpiry()
      log('Token acquired successfully (expires in %ds)', exp ? Math.floor(exp - Date.now() / 1000) : 'unknown')
      return {
        success: true,
        token: this.cachedToken
      }
    } catch (error) {
      log('Token acquisition failed: %s', error instanceof Error ? error.message : 'Unknown error')
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get token',
      }
    }
  }

  private getTokenExpiry(): number | null {
    if (!this.cachedToken) return null
    try {
      const decoded = decodeJwt(this.cachedToken)
      return decoded.exp || null
    } catch {
      return null
    }
  }

  private isExpired(bufferSeconds = 60): boolean {
    const exp = this.getTokenExpiry()
    if (!exp) return true
    return Date.now() / 1000 >= (exp - bufferSeconds)
  }

  clearCache(): void {
    this.cachedToken = undefined
  }
}
