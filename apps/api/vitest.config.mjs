import { defineConfig } from 'vitest/config'
import { env } from 'node:process'

const configuredWorkers = env.GRAPHQL_VERIFICATION_UNIT_WORKERS
const maxWorkers = configuredWorkers === undefined ? 4 : Number(configuredWorkers)
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 256) {
  throw new Error('Verification unit workers must be an integer from 1 to 256')
}

export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers,
  },
})
