import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers: 12,
    // Ignore compiled tests left by older builds.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
})
