import type { ClientConfig } from '../types/index.js'
import { createTransformRequest } from './createTransformRequest.js'

export function transformRequest(url: string, config: ClientConfig) {
  const token = config.getToken?.() ?? config.token
  return createTransformRequest(config.apiUrl, () => token)(url)
}
