import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { NodeTelemetryInfo } from './NodeTelemetryInfo'

it('shows an explicit unavailable state and sends no request without an exact selection', async () => {
  let requests = 0
  server.use(http.post('*/api/management/resource-telemetry/read', () => { requests += 1; return HttpResponse.json({}) }))
  render(<QueryClientProvider client={new QueryClient()}><NodeTelemetryInfo /></QueryClientProvider>)
  expect(screen.getByText('Computer and resource use unavailable')).toBeInTheDocument()
  expect(screen.queryByText('0.0%')).toBeNull()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(requests).toBe(0)
})
