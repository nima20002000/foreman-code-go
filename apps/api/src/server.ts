import { loadEnvFile } from 'node:process'
import { mkdir } from 'node:fs/promises'

import { loadConfig } from './config.js'
import { createCheckpointStore } from './infrastructure/checkpoints.js'
import { createDatabase } from './infrastructure/database.js'
import { ensureAcceptanceSeed } from './infrastructure/seed.js'
import { buildProductionApp } from './production.js'

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
  const config = loadConfig(process.env)
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(
    config.database.connectionString,
    config.checkpoints.schema,
    config.database,
  )
  const { app, initialize, reconcile, drainShutdown } = buildProductionApp(config, database, checkpoints)
  let reconciliationTimer: NodeJS.Timeout | undefined
  const reportReconciliationError = (error: unknown) => app.log.error({ err: error }, 'run reconciliation failed')

  app.addHook('onClose', async () => {
    if (reconciliationTimer) clearInterval(reconciliationTimer)
    try { await drainShutdown() }
    finally { await Promise.allSettled([checkpoints.close(), database.close()]) }
  })

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= app.close()
    return closing
  }
  const onSignal = () => { void close().catch((error: unknown) => {
    app.log.error({ err: error }, 'shutdown failed')
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
    await database.ping()
    stopIfClosing()
    await database.migrate()
    stopIfClosing()
    await ensureAcceptanceSeed(database.pool)
    stopIfClosing()
    await checkpoints.setup()
    stopIfClosing()
    await checkpoints.ping()
    stopIfClosing()
    await mkdir(config.harnesses.workspaceRoot, { recursive: true })
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
  } catch (error) {
    if (closing) { await closing; return }
    await close()
    throw error
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error'
  process.stderr.write(`graphql-api failed to start: ${message}\n`)
  process.exitCode = 1
})
