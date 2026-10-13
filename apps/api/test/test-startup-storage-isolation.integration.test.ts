import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it.each([
  'CODEX_HOME', 'FILE_STORAGE_ROOT', 'HARNESS_WORKSPACE_ROOT',
  'WORKSPACE_STORAGE_ROOT', 'FOREMAN_CODE_APP_MCP_DIRECTORY',
])(
  'refuses prepared native acceptance when the real API uses an unowned %s',
  rejectsUnownedStartup,
  120_000,
)
