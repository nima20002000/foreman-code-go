import { isAbsolute } from 'node:path'
import { resolveLocalBrowserOrigin } from '@graphql/contracts/browser-origin'
import { z } from 'zod'
import type { WorkerExecutionSettings } from '@graphql/contracts/management'
import { defaultFileStorageRoot } from './modules/files/storage.js'
import { readBrowserAuthConfig, type BrowserAuthConfig } from './modules/browser-auth/config.js'
import { harnessBinaries } from './modules/harnesses/binaries.js'

const databaseSchemaName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z_][a-z0-9_]*$/, 'must be a lowercase PostgreSQL identifier')

const EnvironmentSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().max(2147483647).default(1000),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().max(2147483647).default(2000),
  LANGGRAPH_CHECKPOINT_SCHEMA: databaseSchemaName.default('langgraph'),
  FILE_STORAGE_ROOT: z.string().trim().min(1).refine(isAbsolute, 'File storage requires an absolute directory').optional(),
  WORKSPACE_STORAGE_ROOT: z.string().trim().min(1).refine(isAbsolute, 'Workspace storage requires an absolute directory').optional(),
  HARNESS_WORKSPACE_ROOT: z.string().trim().min(1).default('/tmp/graphql-harness-runs'),
  HARNESS_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  CODEX_BINARY: z.string().trim().min(1).default('codex'),
  OPENCODE_BINARY: z.string().trim().min(1).default('opencode'),
  GRAPHQL_LAPTOP_EXECUTION_ENABLED: z.enum(['0', '1']).default('0'),
  GRAPHQL_LOCAL_PRODUCTION: z.enum(['0', '1']).default('0'),
})

export interface ApiConfig {
  workerExecution?: WorkerExecutionSettings
  /** Trusted composition override for an isolated storage root; never a request field. */
  workspaceStorageRoot?: string
  /** App-managed durable upload storage; separate from workspace and harness directories. */
  fileStorageRoot?: string
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
  if (parsed.GRAPHQL_LOCAL_PRODUCTION === '1'
    && (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.HOST)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(parsed.DATABASE_URL).hostname))) {
    throw new Error('Local production requires a loopback API and database.')
  }
  const browserAuth = readBrowserAuthConfig(environment)
  const localDevBrowserAccess = environment.GRAPHQL_DEV_BROWSER_ACCESS === '1'
  if (environment.GRAPHQL_DEV_BROWSER_ACCESS !== undefined && !['0', '1'].includes(environment.GRAPHQL_DEV_BROWSER_ACCESS)) {
    throw new Error('GRAPHQL_DEV_BROWSER_ACCESS must be 0 or 1.')
  }
  const browserOrigin = localDevBrowserAccess ? resolveLocalBrowserOrigin(environment).origin : undefined
  if (localDevBrowserAccess && (environment.NODE_ENV === 'production' || parsed.HOST !== '127.0.0.1'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(parsed.DATABASE_URL).hostname)
    || (browserAuth && browserAuth.origin !== browserOrigin))) {
    throw new Error('Local development browser access requires a loopback API, database and browser origin outside production.')
  }
  const localDevBrowserPrincipalId = environment.GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID?.trim()
  if (localDevBrowserPrincipalId && localDevBrowserPrincipalId.length > 200) {
    throw new Error('GRAPHQL_DEV_OPERATOR_PRINCIPAL_ID must be a valid principal ID.')
  }
  return {
    workerExecution: {
      enabled: parsed.GRAPHQL_LAPTOP_EXECUTION_ENABLED === '1',
      managedBy: 'startup',
    },
    ...(browserAuth ? { browserAuth } : {}),
    ...(localDevBrowserAccess ? { localDevBrowserAccess: {
      origin: browserOrigin!,
      ...(localDevBrowserPrincipalId || browserAuth?.ownerPrincipalId
        ? { principalId: localDevBrowserPrincipalId || browserAuth?.ownerPrincipalId } : {}),
    } } : {}),
    fileStorageRoot: parsed.FILE_STORAGE_ROOT ?? defaultFileStorageRoot(),
    ...(parsed.WORKSPACE_STORAGE_ROOT ? { workspaceStorageRoot: parsed.WORKSPACE_STORAGE_ROOT } : {}),
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
