import { z } from 'zod'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BrowserAuthEnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32).max(256),
  BETTER_AUTH_URL: z.string().url().default('http://127.0.0.1:5173'),
  OWNER_SETUP_SECRET: z.string().min(32).max(256).optional(),
  OWNER_OPERATOR_PRINCIPAL_ID: z.string().trim().min(1).max(200).optional(),
})

export interface BrowserAuthConfig {
  secret: string
  origin: string
  setupSecret?: string | undefined
  ownerPrincipalId?: string | undefined
}

/** No generated development secret, public registration, or implicit trust-proxy. */
export function readBrowserAuthConfig(environment: NodeJS.ProcessEnv): BrowserAuthConfig | undefined {
  const keys = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'OWNER_SETUP_SECRET', 'OWNER_OPERATOR_PRINCIPAL_ID'] as const
  if (keys.every((key) => environment[key] === undefined)) return undefined
  const parsed = BrowserAuthEnvironmentSchema.parse(environment)
  const url = new URL(parsed.BETTER_AUTH_URL)
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('BETTER_AUTH_URL must be the exact loopback browser origin, including its port. Existing Host restrictions remain in effect.')
  }
  if (parsed.OWNER_SETUP_SECRET === parsed.BETTER_AUTH_SECRET) {
    throw new Error('OWNER_SETUP_SECRET must differ from BETTER_AUTH_SECRET.')
  }
  return {
    secret: parsed.BETTER_AUTH_SECRET,
    origin: url.origin,
    ...(parsed.OWNER_SETUP_SECRET ? { setupSecret: parsed.OWNER_SETUP_SECRET } : {}),
    ...(parsed.OWNER_OPERATOR_PRINCIPAL_ID ? { ownerPrincipalId: parsed.OWNER_OPERATOR_PRINCIPAL_ID } : {}),
  }
}
