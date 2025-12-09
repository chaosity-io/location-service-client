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

export class TokenProvider {
  private config: TokenProviderConfig
  private cachedToken?: string
  private expiresAt?: number

  constructor(config: TokenProviderConfig) {
    this.config = config
  }

  async getToken(forceRefresh = false): Promise<TokenResponse> {
    if (!forceRefresh && this.cachedToken && this.expiresAt && !this.isExpired()) {
      return {
        success: true,
        token: this.cachedToken,
        expiresAt: this.expiresAt
      }
    }

    try {
      const response = await fetch(`${this.config.apiUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'client_credentials',
        }),
      })

      if (!response.ok) {
        throw new Error(`Failed to get token: ${response.statusText}`)
      }

      const data = await response.json()
      this.cachedToken = data.access_token
      this.expiresAt = Date.now() + (data.expires_in * 1000)

      return {
        success: true,
        token: this.cachedToken,
        expiresIn: data.expires_in,
        expiresAt: this.expiresAt,
      }
    } catch (error) {
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
