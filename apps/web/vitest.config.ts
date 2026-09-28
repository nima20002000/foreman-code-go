import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    globalSetup: ['../../scripts/vitest-heavy-setup.mjs'],
    // Leave CPU headroom for the Vitest coordinator and jsdom.
    maxWorkers: 12,
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    passWithNoTests: false,
  },
})
