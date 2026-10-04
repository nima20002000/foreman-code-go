import { resolveLocalBrowserOrigin } from '@foreman-code/contracts/browser-origin'
import { z } from 'zod'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BrowserAuthEnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32).max(256),
  BETTER_AUTH_URL: z.string().url().optional(),
  OWNER_OPERATOR_PRINCIPAL_ID: z.string().trim().min(1).max(200).optional(),
})

export interface BrowserAuthConfig {
  secret: string
  origin: string
  ownerPrincipalId?: string | undefined
}

/** No generated development session secret, public registration, or implicit trust-proxy. */
export function readBrowserAuthConfig(environment: NodeJS.ProcessEnv): BrowserAuthConfig | undefined {
  const keys = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'OWNER_OPERATOR_PRINCIPAL_ID'] as const
  if (keys.every((key) => environment[key] === undefined)) return undefined
  const parsed = BrowserAuthEnvironmentSchema.parse(environment)
  const url = new URL(parsed.BETTER_AUTH_URL ?? resolveLocalBrowserOrigin(environment).origin)
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('BETTER_AUTH_URL must be the exact loopback browser origin, including its port. Existing Host restrictions remain in effect.')
  }
  if ((environment.FOREMAN_CODE_BROWSER_ORIGIN !== undefined || environment.FOREMAN_CODE_WEB_PORT !== undefined || environment.FOREMAN_CODE_DEV_BROWSER_ORIGIN !== undefined || environment.GRAPHQL_BROWSER_ORIGIN !== undefined || environment.GRAPHQL_WEB_PORT !== undefined || environment.GRAPHQL_DEV_BROWSER_ORIGIN !== undefined)
    && url.origin !== resolveLocalBrowserOrigin(environment).origin) {
    throw new Error('BETTER_AUTH_URL conflicts with the configured browser origin.')
  }
  return {
    secret: parsed.BETTER_AUTH_SECRET,
    origin: url.origin,
    ...(parsed.OWNER_OPERATOR_PRINCIPAL_ID ? { ownerPrincipalId: parsed.OWNER_OPERATOR_PRINCIPAL_ID } : {}),
  }
}
