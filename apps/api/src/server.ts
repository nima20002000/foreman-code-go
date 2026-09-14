import { loadEnvFile } from 'node:process'
import { mkdir } from 'node:fs/promises'

import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createCheckpointStore } from './infrastructure/checkpoints.js'
import { createDatabase } from './infrastructure/database.js'
import { ensureAcceptanceSeed } from './infrastructure/seed.js'
import { LocalHarnessResolver } from './modules/harnesses/resolver.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'

async function main() {
  // loadEnvFile is available at the declared Node 22.0 runtime baseline, unlike
  // --env-file-if-exists. Missing local configuration is normal in production.
  try {
    loadEnvFile()
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  const config = loadConfig(process.env)
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(
    config.database.connectionString,
    config.checkpoints.schema,
    config.database,
  )
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows)
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const harnesses = new LocalHarnessResolver(config.harnesses.codexBinary, config.harnesses.openCodeBinary)
  const engine = new LangGraphWorkflowEngine(
    runs,
    workflows,
    harnesses,
    checkpoints.saver,
    config.harnesses.workspaceRoot,
    config.harnesses.timeoutMs,
  )
  const app = buildApp({
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    product: { workspaces, workflows, runs, engine },
    logger: true,
  })

  app.addHook('onClose', async () => {
    await engine.shutdown()
    await Promise.allSettled([checkpoints.close(), database.close()])
  })

  try {
    await database.ping()
    await database.migrate()
    await ensureAcceptanceSeed(database.pool)
    await checkpoints.setup()
    await checkpoints.ping()
    await mkdir(config.harnesses.workspaceRoot, { recursive: true })
    await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    await app.close()
    throw error
  }

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error'
  process.stderr.write(`graphql-api failed to start: ${message}\n`)
  process.exitCode = 1
})
