import { configDefaults, defineConfig } from 'vitest/config'
import { vitestResultOptions } from '../../scripts/test-results.mjs'

export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers: 12,
    // Mutation testing runs unit tests only; integration and acceptance tests need PostgreSQL or real harnesses.
    exclude: process.env.UNIT_TESTS_ONLY
      ? [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.acceptance.test.ts']
      : configDefaults.exclude,
    ...vitestResultOptions(),
  },
})
