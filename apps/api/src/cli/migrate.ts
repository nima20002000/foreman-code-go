import { loadConfig } from '../config.js'
import { createDatabase } from '../infrastructure/database.js'
import { createCheckpointStore } from '../infrastructure/checkpoints.js'

const config = loadConfig(process.env)
const database = createDatabase(config.database)
const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
try {
  await database.migrate()
  await checkpoints.setup()
  console.log('Application and checkpoint migrations applied.')
} finally {
  await Promise.all([checkpoints.close(), database.close()])
}
