import '@fontsource-variable/inter'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { AppProviders } from './app/providers'
import { router } from './app/router'
import { initializeTheme } from './features/theme'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('The application root element is missing.')
}

initializeTheme()

async function enableDevelopmentMocks() {
  if (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false') return

  const { startMockWorker } = await import('./mocks/browser')
  await startMockWorker()
}

async function bootstrap(element: HTMLElement) {
  await enableDevelopmentMocks()

  createRoot(element).render(
    <StrictMode>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  )
}

void bootstrap(rootElement)
