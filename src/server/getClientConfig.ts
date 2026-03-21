import debug from 'debug'
import { TokenProvider } from '../auth/TokenProvider'
import type { ClientConfig } from '../types'
export interface ServerAuthConfig {
  apiUrl?: string
  clientId?: string
  clientSecret?: string
}

const log = debug('location-client:clientConfig')

// Singleton instance to prevent race conditions
let tokenProviderInstance: TokenProvider | null = null
let currentConfig: string | null = null

function getTokenProvider(
  apiUrl: string,
  clientId: string,
  clientSecret: string,
): TokenProvider {
  const configKey = `${apiUrl}:${clientId}`

  // Reuse existing instance if config matches
  if (tokenProviderInstance && currentConfig === configKey) {
    log('[getTokenProvider] Reusing existing TokenProvider instance')
    return tokenProviderInstance
  }

  // Create new instance if config changed
  log('[getTokenProvider] Creating new TokenProvider instance')
  tokenProviderInstance = new TokenProvider({ apiUrl, clientId, clientSecret })
  currentConfig = configKey
  return tokenProviderInstance
}

export interface ServerClientConfig extends ClientConfig {
  expiresAt?: number
}

/**
 * Get client configuration with OAuth2 authentication.
 *
 * Automatically reads from environment variables:
 * - LOCATION_API_URL or LOCATION_SERVICE_API_URL
 * - LOCATION_CLIENT_ID or LOCATION_SERVICE_CLIENT_ID
 * - LOCATION_CLIENT_SECRET or LOCATION_SERVICE_CLIENT_SECRET
 *
 * You can override any value by passing it explicitly.
 *
 * WARNING: This function uses client credentials (clientId/clientSecret).
 * Only call this from:
 * - Next.js Server Components/Actions
 * - Node.js backend servers
 * - API routes
 *
 * NEVER call from browser/client code as it exposes credentials.
 * For SPA projects, create your own backend endpoint that calls this.
 *
 * @example
 * // Auto-detect from environment
 * const config = await getClientConfig()
 *
 * // Or override specific values
 * const config = await getClientConfig({ apiUrl: 'https://custom.api.com' })
 *
 * // Use getToken() for automatic caching and refresh
 * const { token } = await config.getToken()
 * const connector = new LocationServiceConnector({ apiUrl: config.apiUrl, token })
 */
export async function getClientConfig(
  config: ServerAuthConfig = {},
): Promise<ServerClientConfig> {
  log('[getClientConfig] Starting with config:', {
    hasApiUrl: !!config.apiUrl,
    hasClientId: !!config.clientId,
  })

  // Auto-detect from environment with fallbacks
  const apiUrl =
    config.apiUrl ||
    process.env.LOCATION_API_URL ||
    process.env.LOCATION_SERVICE_API_URL

  const clientId =
    config.clientId ||
    process.env.LOCATION_CLIENT_ID ||
    process.env.LOCATION_SERVICE_CLIENT_ID

  const clientSecret =
    config.clientSecret ||
    process.env.LOCATION_CLIENT_SECRET ||
    process.env.LOCATION_SERVICE_CLIENT_SECRET

  log('[getClientConfig] Resolved config:', {
    apiUrl,
    clientId: clientId?.substring(0, 10) + '...',
  })

  // Validate required values
  if (!apiUrl || !clientId || !clientSecret) {
    console.error('[getClientConfig] Missing required configuration')
    throw new Error(
      'Missing required configuration. Set environment variables: ' +
        'LOCATION_API_URL, LOCATION_CLIENT_ID, LOCATION_CLIENT_SECRET',
    )
  }

  log('[getClientConfig] Getting TokenProvider instance')
  const provider = getTokenProvider(apiUrl, clientId, clientSecret)

  log('[getClientConfig] Fetching token')
  const result = await provider.getToken()

  if (!result.success || !result.token) {
    console.error('[getClientConfig] Token fetch failed:', result.error)
    const isAuthError =
      result.error === 'Invalid credentials' ||
      result.error?.toLowerCase().includes('unauthorized')
    throw new Error(
      isAuthError
        ? `Authentication failed for client ID "${clientId}". ` +
            `Verify LOCATION_CLIENT_ID and LOCATION_CLIENT_SECRET match your application in the developer portal.`
        : result.error || 'Failed to get token',
    )
  }

  log(
    '[getClientConfig] Token fetched successfully, length:',
    result.token.length,
  )
  return {
    apiUrl,
    token: result.token,
    expiresAt: result.expiresAt,
  }
}
