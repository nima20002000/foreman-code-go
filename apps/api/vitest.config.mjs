import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Leave CPU headroom for the Vitest coordinator and application processes.
    maxWorkers: 10,
  },
})
