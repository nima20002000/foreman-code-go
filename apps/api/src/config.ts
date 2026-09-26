import { z } from 'zod'
import { readBrowserAuthConfig, type BrowserAuthConfig } from './modules/browser-auth/config.js'
import { harnessBinaries } from './modules/harnesses/binaries.js'

const databaseSchemaName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z_][a-z0-9_]*$/, 'must be a lowercase PostgreSQL identifier')

const LOCAL_DEV_BROWSER_ORIGIN = 'http://127.0.0.1:5173'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function readLocalDevBrowserOrigin(value: string | undefined): string {
  const url = new URL(value ?? LOCAL_DEV_BROWSER_ORIGIN)
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port
    || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('GRAPHQL_DEV_BROWSER_ORIGIN must be one exact HTTP loopback browser origin, including its port.')
  }
  return url.origin
}

const EnvironmentSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(2147483647).default(1000),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().max(2147483647).default(2000),
  LANGGRAPH_CHECKPOINT_SCHEMA: databaseSchemaName.default('langgraph'),
  HARNESS_WORKSPACE_ROOT: z.string().trim().min(1).default('/tmp/graphql-harness-runs'),
  HARNESS_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  CODEX_BINARY: z.string().trim().min(1).default('codex'),
  OPENCODE_BINARY: z.string().trim().min(1).default('opencode'),
})

export interface ApiConfig {
  /** Trusted composition override for an isolated storage root; never a request field. */
  workspaceStorageRoot?: string
  browserAuth?: BrowserAuthConfig
  localDevBrowserAccess?: { origin: string; principalId?: string | undefined }
  host: string
  port: number
  readinessTimeoutMs: number
  database: {
    connectionString: string
    maxConnections: number
    connectionTimeoutMs: number
    queryTimeoutMs: number
  }
  checkpoints: {
    schema: string
  }
  harnesses: {
    workspaceRoot: string
    timeoutMs: number
    codexBinary: string
    openCodeBinary: string
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = EnvironmentSchema.parse(environment)
  const browserAuth = readBrowserAuthConfig(environment)
  const localDevBrowserAccess = environment.GRAPHQL_DEV_BROWSER_ACCESS === '1'
  if (environment.GRAPHQL_DEV_BROWSER_ACCESS !== undefined && !['0', '1'].includes(environment.GRAPHQL_DEV_BROWSER_ACCESS)) {
    throw new Error('GRAPHQL_DEV_BROWSER_ACCESS must be 0 or 1.')
  }
  const localDevBrowserOrigin = readLocalDevBrowserOrigin(environment.GRAPHQL_DEV_BROWSER_ORIGIN)
  if (localDevBrowserAccess && (environment.NODE_ENV === 'production' || parsed.HOST !== '127.0.0.1'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(parsed.DATABASE_URL).hostname)
    || (browserAuth && browserAuth.origin !== localDevBrowserOrigin))) {
    throw new Error('Local development browser access requires a loopback API, database and browser origin outside production.')
  }
  const localDevBrowserPrincipalId = environment.GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID?.trim()
  if (localDevBrowserPrincipalId && localDevBrowserPrincipalId.length > 200) {
    throw new Error('GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID must be a valid principal ID.')
  }
  return {
    ...(browserAuth ? { browserAuth } : {}),
    ...(localDevBrowserAccess ? { localDevBrowserAccess: {
      origin: localDevBrowserOrigin,
      ...(localDevBrowserPrincipalId || browserAuth?.ownerPrincipalId
        ? { principalId: localDevBrowserPrincipalId || browserAuth?.ownerPrincipalId } : {}),
    } } : {}),
    host: parsed.HOST,
    port: parsed.PORT,
    readinessTimeoutMs: parsed.READINESS_TIMEOUT_MS,
    database: {
      connectionString: parsed.DATABASE_URL,
      maxConnections: parsed.DATABASE_POOL_MAX,
      connectionTimeoutMs: parsed.DATABASE_CONNECTION_TIMEOUT_MS,
      queryTimeoutMs: parsed.DATABASE_QUERY_TIMEOUT_MS,
    },
    checkpoints: { schema: parsed.LANGGRAPH_CHECKPOINT_SCHEMA },
    harnesses: {
      workspaceRoot: parsed.HARNESS_WORKSPACE_ROOT,
      timeoutMs: parsed.HARNESS_TIMEOUT_MS,
      ...harnessBinaries({ CODEX_BINARY: parsed.CODEX_BINARY, OPENCODE_BINARY: parsed.OPENCODE_BINARY }),
    },
  }
}
