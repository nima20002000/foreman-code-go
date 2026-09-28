import { loadEnvFile } from 'node:process'
import { mkdir, realpath } from 'node:fs/promises'

import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { pathsOverlap } from './modules/workspaces/filesystem.js'
import { loadConfig } from './config.js'
import { createCheckpointStore } from './infrastructure/checkpoints.js'
import { createDatabase } from './infrastructure/database.js'
import { componentLogger, enableFileLogging } from './infrastructure/logger.js'
import { installProcessLifecycleLogging } from './infrastructure/processLifecycle.js'
import { registerProductionFileStorage } from './modules/files/production.js'
import { buildProductionApp } from './production.js'

const lifecycle = componentLogger('lifecycle')
// First, before configuration or infrastructure can fail: nothing may end silently.
installProcessLifecycleLogging(lifecycle)

async function main() {
  // loadEnvFile is available at the declared Node 22.0 runtime baseline, unlike
  // --env-file-if-exists. Missing local configuration is normal in production.
  try {
    loadEnvFile(process.env.GRAPHQL_API_ENV_FILE)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  await enableFileLogging(process.env)
  lifecycle.info({ node: process.version }, 'api starting')
  const config = loadConfig(process.env)
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(
    config.database.connectionString,
    config.checkpoints.schema,
    config.database,
  )
  const { app, initialize, reconcile, drainShutdown } = buildProductionApp(config, database, checkpoints, componentLogger('http'))
  let reconciliationTimer: NodeJS.Timeout | undefined
  const engineLog = componentLogger('engine')
  const reportReconciliationError = (error: unknown) => engineLog.error({ err: error }, 'run reconciliation failed')

  app.addHook('onClose', async () => {
    lifecycle.info('api shutting down')
    if (reconciliationTimer) clearInterval(reconciliationTimer)
    try { await drainShutdown() }
    finally {
      await Promise.allSettled([checkpoints.close(), database.close()])
      lifecycle.info('api stopped')
    }
  })

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= app.close()
    return closing
  }
  const onSignal = () => { void close().catch((error: unknown) => {
    lifecycle.error({ err: error }, 'shutdown failed')
    process.exitCode = 1
  }) }
  // Recovery can run native work. Signals must own cleanup before listening or
  // any initialization await, including partially initialized infrastructure.
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  app.addHook('onClose', async () => {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  })
  const stopIfClosing = () => { if (closing) throw new Error('Startup canceled by shutdown.') }

  try {
    registerProductionFileStorage(app, database.pool, config)
    await database.ping()
    stopIfClosing()
    await database.migrate()
    stopIfClosing()
    await checkpoints.setup()
    stopIfClosing()
    await checkpoints.ping()
    stopIfClosing()
    await mkdir(config.harnesses.workspaceRoot, { recursive: true })
    const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
    await mkdir(projectRoot, { recursive: true })
    if (pathsOverlap(await realpath(projectRoot), await realpath(config.harnesses.workspaceRoot))) {
      throw new Error('Workspace storage and harness runtime storage must be separate directories.')
    }
    stopIfClosing()
    await initialize()
    stopIfClosing()
    // Native recovery may call the scoped MCP endpoint during attachment.
    await app.listen({ host: config.host, port: config.port })
    stopIfClosing()
    await reconcile(reportReconciliationError)
    stopIfClosing()
    reconciliationTimer = setInterval(() => {
      void reconcile(reportReconciliationError).catch(reportReconciliationError)
    }, 5_000)
    reconciliationTimer.unref()
    lifecycle.info({ host: config.host, port: config.port }, 'api ready')
  } catch (error) {
    if (closing) { await closing; return }
    await close()
    throw error
  }
}

main().catch((error: unknown) => {
  lifecycle.fatal({ err: error }, 'api failed to start')
  process.exitCode = 1
})
