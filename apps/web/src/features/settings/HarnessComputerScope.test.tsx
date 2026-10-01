import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { HarnessComputerScope } from './HarnessComputerScope'
import { HarnessComputerSearchSchema } from './harnessComputerSearch'
const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const clients: QueryClient[] = []
function scope(computer?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><HarnessComputerScope selectedComputer={computer} onSelectComputer={() => {}}><p>Global preset editor</p></HarnessComputerScope></QueryClientProvider>)
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
describe('explicit harness settings computer scope', () => {
  it('validates canonical URL device selection while retaining provider and section', () => {
    expect(HarnessComputerSearchSchema.parse({ computer: deviceId, harness: 'opencode', section: 'permissions' })).toEqual({ computer: deviceId, harness: 'opencode', section: 'permissions' })
    expect(HarnessComputerSearchSchema.safeParse({ computer: 'browser-invented-host' }).success).toBe(false)
  })
  it('withdraws a denied selected host and never substitutes global preset editing', async () => {
    server.use(http.get('/api/devices/main', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Access denied.' } }, { status: 403 })))
    scope('main')
    expect(await screen.findByText(/This computer is unavailable or access is not authorized/)).toBeVisible()
    expect(screen.queryByText('Global preset editor')).not.toBeInTheDocument()
  })
  it('keeps registration revocation separate from provider readiness', async () => {
    server.use(http.get('/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'public', mainPublicKeyFingerprint: 'a'.repeat(64) })),
      http.get('/api/devices', () => HttpResponse.json({ devices: [{ mainId, deviceId, workerInstallationId: deviceId, publicKeyFingerprint: 'b'.repeat(64), keyRevision: 1, authorizationRevision: 2, status: 'revoked', scopes: ['connect', 'heartbeat'] }] })))
    scope(deviceId)
    expect(await screen.findByText(/This computer is unavailable or access is not authorized/)).toBeVisible()
    expect(screen.getByRole('option', { name: `${deviceId} · revoked` })).toBeDisabled()
    expect(screen.queryByText('Global preset editor')).not.toBeInTheDocument()
  })
})
