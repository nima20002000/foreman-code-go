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
  LANGGRAPH_CHECKPOINT_SCHEMA: databaseSchemaName.default('langgraph'),
})

export interface ApiConfig {
  host: string
  port: number
  database: {
    connectionString: string
    maxConnections: number
    connectionTimeoutMs: number
  }
  checkpoints: {
    schema: string
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const parsed = EnvironmentSchema.parse(environment)
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    database: {
      connectionString: parsed.DATABASE_URL,
      maxConnections: parsed.DATABASE_POOL_MAX,
      connectionTimeoutMs: parsed.DATABASE_CONNECTION_TIMEOUT_MS,
    },
    checkpoints: { schema: parsed.LANGGRAPH_CHECKPOINT_SCHEMA },
  }
}
