import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { server } from '../../mocks/server'
import { HarnessComputerScope } from './HarnessComputerScope'
import { HarnessComputerSearchSchema } from './harnessComputerSearch'
const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const clients: QueryClient[] = []
function scope(computer?: string, onSelectComputer = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><HarnessComputerScope selectedComputer={computer} onSelectComputer={onSelectComputer}><p>Global preset editor</p></HarnessComputerScope></QueryClientProvider>)
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
describe('explicit harness settings computer scope', () => {
  it('validates canonical URL device selection while retaining provider and section', () => {
    expect(HarnessComputerSearchSchema.parse({ computer: deviceId, harness: 'claude', section: 'permissions' })).toEqual({ computer: deviceId, harness: 'claude', section: 'permissions' })
    expect(HarnessComputerSearchSchema.safeParse({ computer: 'browser-invented-host' }).success).toBe(false)
    expect(HarnessComputerSearchSchema.parse({ harness: 'opencode' }).harness).toBeUndefined()
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
    expect(screen.getByRole('option', { name: 'Computer 22222222… · revoked' })).toBeDisabled()
    const details = screen.getByText('Selected computer identity').closest('details')!
    await userEvent.click(within(details).getByText('Selected computer identity'))
    expect(within(details).getByText('Device').nextElementSibling).toHaveTextContent(deviceId)
    expect(screen.queryByText('Global preset editor')).not.toBeInTheDocument()
  })
  it('keeps canonical values and distinguishes computers with matching short identities', async () => {
    const secondId = '22222222-3333-4333-8333-333333333333'
    const onSelect = vi.fn()
    server.use(http.get('/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'public', mainPublicKeyFingerprint: 'a'.repeat(64) })),
      http.get('/api/devices', () => HttpResponse.json({ devices: [deviceId, secondId].map(id => ({ mainId, deviceId: id, workerInstallationId: id, publicKeyFingerprint: 'b'.repeat(64), keyRevision: 1, authorizationRevision: 2, status: 'paired', scopes: ['connect', 'heartbeat'] })) })))
    scope(undefined, onSelect)
    expect(await screen.findByRole('option', { name: 'Main' })).toHaveValue('main')
    const second = await screen.findByRole('option', { name: 'Computer 22222222-3… · paired' })
    expect(screen.getByRole('option', { name: 'Computer 22222222-2… · paired' })).toHaveValue(deviceId)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Settings scope' }), second)
    expect(onSelect).toHaveBeenCalledWith(secondId)
  })
})
