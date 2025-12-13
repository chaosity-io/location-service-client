import { ClientConfig } from '../types'
import { TokenProvider, TokenProviderConfig } from '../auth/TokenProvider'

export type ServerAuthConfig = TokenProviderConfig

/**
 * Get client configuration with OAuth2 authentication.
 * 
 * WARNING: This function uses client credentials (clientId/clientSecret).
 * Only call this from:
 * - Next.js Server Components/Actions
 * - Node.js backend servers
 * - API routes
 * 
 * NEVER call from browser/client code as it exposes credentials.
 * For SPA projects, create your own backend endpoint that calls this.
 */
export async function getClientConfig(config: ServerAuthConfig): Promise<ClientConfig & { expiresAt?: number }> {
  const provider = new TokenProvider(config)
  const result = await provider.getToken()

  if (!result.success || !result.token) {
    throw new Error(result.error || 'Failed to get token')
  }

  return {
    apiUrl: config.apiUrl,
    token: result.token,
    expiresAt: result.expiresAt,
  }
}
