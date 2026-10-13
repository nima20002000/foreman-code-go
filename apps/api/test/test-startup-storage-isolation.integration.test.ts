import { it } from 'vitest'
import { rejectsUnownedStartup } from './helpers/testStartupIsolation.js'

it(
  'refuses prepared native acceptance when the real API uses an unowned CODEX_HOME',
  () => rejectsUnownedStartup('CODEX_HOME'),
  120_000,
)
