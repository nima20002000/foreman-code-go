import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

import { server } from '../mocks/server'
import { mockRuntimeIdentity, resetTestFixtures } from '../shared/mocks/handlers'
import { useNavigationUiStore } from '../features/workspaces/navigationUiStore'

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
}
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// Ordinary route fixtures model an already-bound installation. Boundary tests
// explicitly exercise first binding, recreation, and unavailable storage.
beforeEach(() => window.localStorage.setItem('graphql.chat-instance-binding', `${mockRuntimeIdentity.checkoutId}:${mockRuntimeIdentity.installationId}`))

afterEach(() => {
  server.resetHandlers()
  resetTestFixtures()
  cleanup()
  useNavigationUiStore.getState().reset()
  vi.restoreAllMocks()
})

afterAll(() => server.close())
