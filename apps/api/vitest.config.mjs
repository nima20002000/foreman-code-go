import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs', '../../scripts/vitest-test-resources.mjs'],
    setupFiles: ['./test/setupResources.ts'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers: 12,
  },
})
