import { defineConfig } from 'vitest/config'
import { vitestResultOptions } from '../../scripts/test-results.mjs'

export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers: 12,
    ...vitestResultOptions(),
  },
})
