import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalMachineReference, DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { ComputerSettings } from './ComputerSettings'
vi.mock('../runtime-qualification/ComputerRuntimeQualification', () => ({ ComputerRuntimeQualification: () => null }))

const fixture = vi.hoisted(() => ({
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  status: 'paired' as DeviceRegistration['status'],
}))
// Read-only mounted reconciliation regression; not a discovery, pairing or grant test.
vi.mock('../../shared/api/runtimeIdentity', () => ({ useRuntimeIdentityQuery: () => ({ data: { installationId: fixture.mainId } }) }))
vi.mock('../../shared/api/computerSettings', () => ({
  useSelectedMainQuery: () => ({ isSuccess: true, data: { mainId: fixture.mainId, mainPublicKeyFingerprint: 'a'.repeat(64) } }),
  useRegisteredComputersQuery: () => ({ isSuccess: true, data: { devices: [{ mainId: fixture.mainId,
    deviceId: fixture.deviceId, workerInstallationId: fixture.deviceId, publicKeyFingerprint: 'b'.repeat(64),
    keyRevision: 1, authorizationRevision: 1, status: fixture.status, scopes: ['connect'] }] } }),
  useHostHarnessRegistryQuery: () => ({ data: { instances: [], installations: [] } }),
}))
vi.mock('./HostHarnessOverrides', () => ({ HostHarnessOverrides: ({ target }: {
  target: { hostRef: CanonicalMachineReference; applicationInstallationId: string }
}) => <section aria-label="Host harness settings">{JSON.stringify(target)}</section> }))
vi.mock('./ComputerPairingForm', () => ({ ComputerPairingForm: () => null }))
vi.mock('./ComputerRevokeButton', () => ({ ComputerRevokeButton: () => null }))
const clients: QueryClient[] = []

function renderComputerSettings(deviceId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <ComputerSettings deviceId={deviceId} />
    </QueryClientProvider>,
  )
}

beforeEach(() => { fixture.status = 'paired' })
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.restoreAllMocks()
})

describe('Computer inventory and settings sibling identities', () => {
  it.each(['main', 'device'] as const)('renders both %s sections without colliding child keys', (kind) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderComputerSettings(kind === 'device' ? fixture.deviceId : undefined)
    expect(screen.getByRole('region', { name: 'Host harness inventory' })).toBeVisible()
    const hostRef = kind === 'device' ? { kind, mainId: fixture.mainId, deviceId: fixture.deviceId }
      : { kind, mainId: fixture.mainId }
    expect(screen.getByRole('region', { name: 'Host harness settings' })).toHaveTextContent(JSON.stringify({
      hostRef, applicationInstallationId: kind === 'device' ? fixture.deviceId : fixture.mainId,
    }))
    expect(errors.mock.calls.filter(args => args.some(value => typeof value === 'string' && value.includes('same key')))).toEqual([])
  })

  it.each([
    ['pending', 'Pairing pending', 'Awaiting pairing'],
    ['paired', 'Paired remote computer', 'See observed connection below'],
    ['revoked', 'Access revoked', 'Unavailable for a revoked worker'],
  ] as const)('labels %s registration accurately in the list and details', (status, label, connection) => {
    fixture.status = status
    renderComputerSettings()
    expect(screen.getByText(`${label} · open for its connection and installations`)).toBeVisible()
    if (status === 'pending') expect(screen.queryByText(/Access revoked/)).not.toBeInTheDocument()
    cleanup()
    renderComputerSettings(fixture.deviceId)
    expect(screen.getByText('Registration').nextElementSibling).toHaveTextContent(status)
    expect(screen.getByText('Worker connection').nextElementSibling).toHaveTextContent(connection)
    if (status === 'pending') expect(screen.queryByText(/revoked/i)).not.toBeInTheDocument()
  })
})
