import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it.each(['WORKSPACE_STORAGE_ROOT', 'FOREMAN_CODE_APP_MCP_DIRECTORY'])(
  'refuses prepared native acceptance when the real API uses an unowned %s',
  rejectsUnownedStartup,
  120_000,
)
