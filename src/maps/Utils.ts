import type { ClientConfig } from '../types'
import { createTransformRequest } from './createTransformRequest'

export function transformRequest(url: string, config: ClientConfig) {
  const token = config.getToken?.() ?? config.token
  return createTransformRequest(config.apiUrl, () => token)(url)
}
