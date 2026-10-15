import { defineConfig } from 'vitest/config'

// One worker shares an embedded database; test files use independent schemas.
export default defineConfig({
  test: {
    include: ['test/**/*.light.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
