export interface LocationServiceExceptionOptions {
  message: string
  code: string
  statusCode: number
  requestId?: string
}

export class LocationServiceException extends Error {
  readonly code: string
  readonly statusCode: number
  readonly requestId?: string

  constructor(options: LocationServiceExceptionOptions) {
    super(options.message)
    this.name = 'LocationServiceException'
    this.code = options.code
    this.statusCode = options.statusCode
    this.requestId = options.requestId
  }

  get isRetryable(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500
  }

  get isThrottling(): boolean {
    return this.code === 'ThrottlingException' || this.statusCode === 429
  }

  get isValidation(): boolean {
    return this.code === 'ValidationException' || this.statusCode === 400
  }

  toString(): string {
    const parts = [`LocationServiceException: [${this.code}] ${this.message}`]
    if (this.requestId) parts.push(`(requestId: ${this.requestId})`)
    return parts.join(' ')
  }
}
