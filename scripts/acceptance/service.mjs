import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { assertOwned, publicError } from './safety.mjs'
import { seed } from './scenarios.mjs'
import { parity } from './parity.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const state = process.env.ENG07_STATE
const owner = process.env.ENG07_OWNER
const kind = process.argv[2]
const apiRequire = createRequire(join(root, 'apps/api/package.json'))
const source = (path) => import(pathToFileURL(join(root, 'apps/api/src', path)).href)
const dependency = (name) => import(pathToFileURL(apiRequire.resolve(name)).href)
const send = (message) => { if (process.connected) process.send(message) }
let close = async () => {}, closing = false
let stage = 'ownership'
async function shutdown() {
  if (closing) return
  closing = true
  try { await close(); send({ type: 'closed' }); process.exit(0) }
  catch { send({ type: 'failure', stage: 'shutdown', code: 'SHUTDOWN_FAILED' }); process.exit(1) }
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('disconnect', () => { void shutdown() })

async function main() {
  await assertOwned(state, owner)
  if (kind === 'web') {
    stage = 'web-start'
    const web = join(root, 'apps/web'), req = createRequire(join(web, 'package.json'))
    const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
    const server = await createServer({ root: web, configFile: join(web, 'vite.config.ts'),
      // Do not load .env/.env.local from the checkout or write its Vite cache.
      envDir: join(state, 'empty-env'), cacheDir: join(state, 'vite-cache'), logLevel: 'silent',
      server: { host: '127.0.0.1', port: Number(process.env.ENG07_WEB_PORT), strictPort: true, open: false } })
    close = () => server.close()
    if (closing) return close()
    await server.listen()
    send({ type: 'ready' })
    return
  }
  if (kind !== 'api') throw new Error('Unknown service.')
  stage = 'database-identity'
  const [{ loadConfig }, { createDatabase }, { createCheckpointStore }, { buildProductionApp }, { PostgresAccessService }, schemas, sdk] = await Promise.all([
    source('config.ts'), source('infrastructure/database.ts'), source('infrastructure/checkpoints.ts'), source('production.ts'),
    source('modules/access/postgres.ts'), dependency('@foreman-code/contracts/wave25'), dependency('@modelcontextprotocol/client'),
  ])
  // Same production composition, engine, checkpointer, migrations and native
  // ownership services as src/server.ts. Only storage root and logger differ.
  const config = { ...loadConfig(process.env), workspaceStorageRoot: join(state, 'projects') }
  const db = createDatabase(config.database)
  close = () => db.close()
  const identity = (await db.pool.query(`select current_database() as database, current_schema() as schema,
    current_setting('data_directory') as directory, current_setting('listen_addresses') as listen`)).rows[0]
  if (identity.database !== process.env.ENG07_DATABASE || identity.schema !== 'eng07'
    || await realpath(identity.directory) !== await realpath(join(state, 'pg')) || identity.listen !== '') throw new Error('Database identity mismatch.')
  stage = 'migrations'
  await db.migrate()
  const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
  close = async () => { await Promise.allSettled([checkpoints.close(), db.close()]) }
  await checkpoints.setup(); await checkpoints.ping()
  for (const path of [config.workspaceStorageRoot, config.harnesses.workspaceRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
  stage = 'api-start'
  const { app, initialize, reconcile, drainShutdown } = buildProductionApp(config, db, checkpoints, false)
  let timer
  app.addHook('onClose', async () => {
    clearInterval(timer)
    try { await drainShutdown() } finally { await Promise.allSettled([checkpoints.close(), db.close()]) }
  })
  close = () => app.close()
  if (closing) return close()
  await initialize()
  await app.listen({ host: config.host, port: config.port })
  // Recovery starts only after the scoped MCP endpoint is listening, exactly
  // like server.ts. Never seed again or submit another Run during a restart.
  const report = () => send({ type: 'notice', code: 'RECONCILIATION_UNRESOLVED' })
  await reconcile(report)
  timer = setInterval(() => { void reconcile(report).catch(report) }, 5_000)
  timer.unref()
  send({ type: 'ready' })
  let operations = Promise.resolve()
  process.on('message', (message) => {
    operations = operations.then(async () => {
      if (closing || !message || !['seed', 'parity'].includes(message.type)) return
      try {
        const apiUrl = `http://127.0.0.1:${config.port}`
        const result = message.type === 'seed'
          ? await seed({ apiUrl, webUrl: config.browserOrigin,
            projectRoot: config.workspaceStorageRoot, codexModel: process.env.ENG07_CODEX_MODEL, schemas })
          : await parity({ apiUrl, workspaceId: message.demo.workspaceId, workflowIds: message.demo.workflowIds,
            runId: message.runId, access: new PostgresAccessService(db.pool), ...sdk })
        send({ type: 'result', requestId: message.requestId, result })
      } catch (error) { send({ type: 'failure', requestId: message.requestId, stage: message.type, code: publicError(error) }) }
    })
  })
}
main().catch(async (error) => {
  send({ type: 'failure', stage, code: publicError(error) })
  try { await close() } finally { process.exit(1) }
})
