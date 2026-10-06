import { loadConfig } from '../config.js'
import { createDatabase } from '../infrastructure/database.js'
import { createCheckpointStore } from '../infrastructure/checkpoints.js'

const config = loadConfig(process.env)
// DDL batches have a separate bounded deadline from individual API requests.
const migrationOptions = { ...config.database, maxConnections: 1, queryTimeoutMs: 60_000 }
const database = createDatabase(migrationOptions)
const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, migrationOptions)
try {
  await database.migrate()
  await checkpoints.setup()
  console.log('Application and checkpoint migrations applied.')
} finally {
  await Promise.all([checkpoints.close(), database.close()])
}
