import { loadProductEnvFile } from '@foreman-code/contracts/product-environment-node'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { mkdir, realpath } from 'node:fs/promises'

import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { pathsOverlap } from './modules/workspaces/filesystem.js'
import { loadConfig } from './config.js'
import { createCheckpointStore } from './infrastructure/checkpoints.js'
import { createDatabase } from './infrastructure/database.js'
import { componentLogger, enableFileLogging } from './infrastructure/logger.js'
import { installProcessLifecycleLogging } from './infrastructure/processLifecycle.js'
import { readTestResourcesIdentity } from './infrastructure/testRuntimeResources.js'
import { buildProductionApp } from './production.js'
import { registerBuiltWeb } from './builtWeb.js'
import { codexQualificationSuite } from './modules/harnesses/qualification/suites/codex.js'
import { join } from 'node:path'
import { readMainRsyncEntrypoint } from './modules/byte-transfer/installedEntrypoints.js'

const lifecycle = componentLogger('lifecycle')
// First, before configuration or infrastructure can fail: nothing may end silently.
installProcessLifecycleLogging(lifecycle)

async function main() {
  // loadEnvFile is available at the declared Node 22.0 runtime baseline, unlike
  // --env-file-if-exists. Missing local configuration is normal in production.
  try {
    loadProductEnvFile()
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  if (readProductEnvironment(process.env, 'TEST_ROOT') || readProductEnvironment(process.env, 'TEST_OWNER')) {
    readTestResourcesIdentity(loadConfig(process.env))
  }
  await enableFileLogging(process.env)
  lifecycle.info({ node: process.version }, 'api starting')
  const config = loadConfig(process.env)
  const database = createDatabase(config.database)
  const rsyncInstallation = await readMainRsyncEntrypoint(join(config.harnesses.workspaceRoot, 'rsync-selection.json'))
  if (rsyncInstallation.kind === 'unavailable') lifecycle.info({ reason: rsyncInstallation.reason }, 'rsync unavailable')
  const checkpoints = createCheckpointStore(
    config.database.connectionString,
    config.checkpoints.schema,
    config.database,
  )
  const { app, initialize, reconcile, drainShutdown, startDeviceListener, registerFileStorage, rsync } = buildProductionApp(config, database, checkpoints,
    componentLogger('http'), undefined, undefined,
    { codex: codexQualificationSuite },
    { mode: 'native', rsyncInstallation })
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
    const webRoot = readProductEnvironment(process.env, 'WEB_DIST')
    if (webRoot) await registerBuiltWeb(app, webRoot)
    registerFileStorage()
    await database.ping()
    stopIfClosing()
    await database.migrate()
    stopIfClosing()
    await checkpoints.setup()
    stopIfClosing()
    await checkpoints.ping()
    stopIfClosing()
    await mkdir(config.harnesses.workspaceRoot, { recursive: true, mode: 0o700 })
    const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
    await mkdir(projectRoot, { recursive: true, mode: 0o700 })
    if (pathsOverlap(await realpath(projectRoot), await realpath(config.harnesses.workspaceRoot))) {
      throw new Error('Workspace storage and harness runtime storage must be separate directories.')
    }
    stopIfClosing()
    await initialize()
    stopIfClosing()
    if (rsync.kind === 'configured') {
      for (const intent of rsync.ownership.inventory()) {
        if (Date.parse(intent.expiresAt) <= Date.now()) await rsync.backend.retireExpired(intent)
      }
    }
    // Native recovery may call the scoped MCP endpoint during attachment.
    await app.listen({ host: config.host, port: config.port })
    stopIfClosing()
    await startDeviceListener()
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
