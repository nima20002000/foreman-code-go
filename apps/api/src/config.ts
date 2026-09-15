import { z } from 'zod'

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
  HARNESS_WORKSPACE_ROOT: z.string().trim().min(1).default('/tmp/graphql-harness-runs'),
  HARNESS_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  CODEX_BINARY: z.string().trim().min(1).default('codex'),
  OPENCODE_BINARY: z.string().trim().min(1).default('opencode'),
})

export interface ApiConfig {
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
  return {
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
      codexBinary: parsed.CODEX_BINARY,
      openCodeBinary: parsed.OPENCODE_BINARY,
    },
  }
}
