import { setupWorker } from 'msw/browser'

import { handlers } from './handlers'

export const worker = setupWorker(...handlers)

/**
 * MSW is opt-in in development and is never started as a production fallback.
 * The app entrypoint can await this before rendering to avoid an initial race.
 */
export async function startMockWorker(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW !== 'true') return
  await worker.start({ onUnhandledRequest: 'error' })
}
