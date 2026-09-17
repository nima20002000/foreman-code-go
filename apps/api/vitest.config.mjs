import { availableParallelism } from 'node:os'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    maxWorkers: Math.max(1, Math.floor(availableParallelism() * 0.75)),
  },
})
