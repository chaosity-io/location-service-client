import { ClientConfig } from "../types"

export function transformRequest(url: string, config: ClientConfig) {
    if (url.startsWith(config.apiUrl)) {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${config.token}`,
        }

        if (url.includes('/tiles/')) {
            headers['Accept'] = 'application/x-protobuf'
        } else if (url.includes('/glyphs/')) {
            headers['Accept'] = 'application/x-protobuf'
        } else if (url.includes('/sprites/') && url.endsWith('.png')) {
            headers['Accept'] = 'image/png'
        } else if (url.includes('/sprites/') && url.endsWith('.json')) {
            headers['Accept'] = 'application/json'
        } else if (url.includes('/descriptor')) {
            headers['Accept'] = 'application/json'
        }

        return { url, headers }
    }
    return { url }
}