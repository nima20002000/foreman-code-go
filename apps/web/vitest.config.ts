import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const configuredWorkers = process.env.GRAPHQL_VERIFICATION_UNIT_WORKERS
const maxWorkers = configuredWorkers === undefined ? 4 : Number(configuredWorkers)
if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 256) {
  throw new Error('Verification unit workers must be an integer from 1 to 256')
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and jsdom.
    maxWorkers,
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    passWithNoTests: false,
  },
})
