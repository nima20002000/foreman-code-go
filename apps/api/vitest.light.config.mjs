import { defineConfig } from 'vitest/config'

// One worker shares an embedded database; test files use independent schemas.
export default defineConfig({
  test: {
    name: 'light-database',
    ...(process.env.CI_PROGRESS_FILE ? {
      runner: '../../packages/contracts/ci-test-runner.mjs',
      reporters: ['default', '../../scripts/ci-progress-reporter.mjs'],
    } : {}),
    include: ['test/**/*.light.test.ts'],
    globalSetup: ['./test/helpers/lightweightDatabaseSetup.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fsModuleCache: true,
  },
})
