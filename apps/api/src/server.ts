import { loadEnvFile } from 'node:process'
import { mkdir } from 'node:fs/promises'

import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createCheckpointStore } from './infrastructure/checkpoints.js'
import { createDatabase } from './infrastructure/database.js'
import { ensureAcceptanceSeed } from './infrastructure/seed.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { GraphDraftService } from './modules/graph-drafts/service.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { LocalHarnessResolver } from './modules/harnesses/resolver.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { RunManagementService } from './modules/runs/management.js'
import { PostgresSettingsRepository } from './modules/settings/postgres.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { WorkflowManagementService } from './modules/workflows/management.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'
import { WorkspaceManagementService } from './modules/workspaces/management.js'
import { AgentManagementService } from './modules/workspaces/agents.js'

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
  const settings = new PostgresSettingsRepository(database.pool)
  const harnesses = new LocalHarnessResolver(config.harnesses.codexBinary, config.harnesses.openCodeBinary)
  const engine = new LangGraphWorkflowEngine(
    runs,
    workflows,
    harnesses,
    checkpoints.saver,
    config.harnesses.workspaceRoot,
    config.harnesses.timeoutMs,
  )
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const operatorServices = {
    workspaces: new WorkspaceManagementService(database.pool, commands),
    workflows: new WorkflowManagementService(database.pool, commands),
    agents: new AgentManagementService(database.pool),
    drafts: new GraphDraftService(database.pool, commands),
    harnesses: new HarnessCatalogService(harnesses, settings, commands, config.harnesses.workspaceRoot),
    runs: new RunManagementService(database.pool, commands, runs, engine),
    commands,
  }
  const app = buildApp({
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    product: { workspaces, workflows, runs, settings, engine },
    operator: { access, services: operatorServices },
    logger: true,
  })
  let reconciliationTimer: NodeJS.Timeout | undefined
  const reportReconciliationError = (error: unknown) => app.log.error({ err: error }, 'run reconciliation failed')

  app.addHook('onClose', async () => {
    if (reconciliationTimer) clearInterval(reconciliationTimer)
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
    await engine.reconcile(reportReconciliationError)
    reconciliationTimer = setInterval(() => {
      void engine.reconcile(reportReconciliationError).catch(reportReconciliationError)
    }, 5_000)
    reconciliationTimer.unref()
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
