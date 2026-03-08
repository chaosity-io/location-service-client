// Custom types not provided by AWS SDK

export interface ClientConfig {
  apiUrl: string
  token: string
  /** Optional callback to get the current token dynamically. When provided,
   *  called on every request so token updates are reflected without recreating the client. */
  getToken?: () => string | undefined
}
