import { setupWorker } from 'msw/browser'

import { handlers } from './handlers'

export const worker = setupWorker(...handlers)

/**
 * MSW is enabled by default in development and can be explicitly disabled with
 * VITE_ENABLE_MSW=false. Production never starts the worker. The app entrypoint
 * awaits this before rendering so normal workspace requests cannot race it.
 */
export async function startMockWorker(): Promise<void> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false') return
  await worker.start({ onUnhandledRequest: 'error' })
}
