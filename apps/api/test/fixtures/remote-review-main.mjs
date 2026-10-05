/* global process */
import { readFile } from 'node:fs/promises'
import { createDatabase } from '../../src/infrastructure/database.ts'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.ts'
import { buildProductionApp } from '../../src/production.ts'

const { config, infrastructure } = JSON.parse(await readFile(process.argv[2], 'utf8'))
const database = createDatabase(config.database)
const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
const production = buildProductionApp(config, database, checkpoints, false,
  undefined, undefined, undefined, infrastructure)
production.registerFileStorage()
await checkpoints.setup()
await production.initialize()
const origin = await production.app.listen({ host: '127.0.0.1', port: config.port })
await production.startDeviceListener()
process.send?.({ kind: 'ready', origin })
let closing = false
let reconciliationFailure
process.on('message', async message => {
  if (message?.kind !== 'reconcile' || closing) return
  try {
    await production.reconcile(error => { throw error })
    process.send?.({ kind: 'reconciled', requestId: message.requestId })
  } catch (error) {
    reconciliationFailure = error
    process.send?.({ kind: 'reconcile-failed', requestId: message.requestId, message: error.message })
  }
})
async function close() {
  if (closing) return
  closing = true
  try {
    await production.shutdown()
    await checkpoints.close()
    await database.close()
    if (reconciliationFailure) throw reconciliationFailure
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(1)
  }
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
