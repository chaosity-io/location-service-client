import ClientOAuth2 from 'client-oauth2'
import debug from 'debug'

const log = debug('location-client:auth')

export interface TokenResponse {
  success: boolean
  token?: string
  expiresIn?: number
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
  private expiresAt?: number
  private oauth2Client: ClientOAuth2

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
    if (!forceRefresh && this.cachedToken && this.expiresAt && !this.isExpired()) {
      log('Using cached token (expires in %ds)', Math.floor((this.expiresAt - Date.now()) / 1000))
      return {
        success: true,
        token: this.cachedToken,
        expiresAt: this.expiresAt
      }
    }

    const reason = forceRefresh ? 'forced refresh' : (this.cachedToken ? 'token expired' : 'no cached token')
    log('Refreshing token (%s) from %s', reason, this.config.apiUrl)
    try {
      const token = await this.oauth2Client.credentials.getToken()
      const expiresIn = typeof token.data?.expires_in === 'number' 
        ? token.data.expires_in 
        : parseInt(token.data?.expires_in || '3600')
      
      this.cachedToken = token.accessToken
      this.expiresAt = Date.now() + (expiresIn * 1000)

      log('Token acquired successfully (expires in %ds)', expiresIn)
      return {
        success: true,
        token: this.cachedToken,
        expiresIn,
        expiresAt: this.expiresAt,
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
    if (!this.expiresAt) return true
    return Date.now() >= (this.expiresAt - bufferSeconds * 1000)
  }

  clearCache(): void {
    this.cachedToken = undefined
    this.expiresAt = undefined
  }
}
