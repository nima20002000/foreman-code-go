import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'

import { server } from '../mocks/server'
import { resetTestFixtures } from '../shared/mocks/handlers'
import { useNavigationUiStore } from '../features/workspaces/navigationUiStore'

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
}
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  server.resetHandlers()
  resetTestFixtures()
  cleanup()
  useNavigationUiStore.getState().reset()
  vi.restoreAllMocks()
})

afterAll(() => server.close())
