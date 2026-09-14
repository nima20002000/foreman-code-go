import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'

import { server } from '../mocks/server'
import { useNavigationUiStore } from '../features/workspaces/navigationUiStore'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

afterEach(() => {
  server.resetHandlers()
  cleanup()
  useNavigationUiStore.getState().reset()
  vi.restoreAllMocks()
})

afterAll(() => server.close())
