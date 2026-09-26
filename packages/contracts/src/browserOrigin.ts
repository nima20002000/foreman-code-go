/** Resolve the configured frontend endpoint before starting either local service. */
export function resolveLocalBrowserOrigin(environment: Record<string, string | undefined>): {
  origin: string; host: string; port: number
} {
  const selectedPort = environment.GRAPHQL_WEB_PORT === undefined ? undefined : Number(environment.GRAPHQL_WEB_PORT)
  if (selectedPort !== undefined && (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535)) {
    throw new Error('GRAPHQL_WEB_PORT must be a valid TCP port.')
  }
  const url = new URL(environment.GRAPHQL_BROWSER_ORIGIN ?? `http://127.0.0.1:${selectedPort ?? 5173}`)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('GRAPHQL_BROWSER_ORIGIN must be an exact HTTP loopback browser origin.')
  }
  const port = Number(url.port || 80)
  if (selectedPort !== undefined && selectedPort !== port) {
    throw new Error('GRAPHQL_WEB_PORT conflicts with GRAPHQL_BROWSER_ORIGIN.')
  }
  return { origin: url.origin, host: url.hostname.replace(/^\[|\]$/g, ''), port }
}
