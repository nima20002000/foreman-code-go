import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalMachineReference } from '@graphql/contracts/device-identity'
import { ComputerSettings } from './ComputerSettings'

const fixture = vi.hoisted(() => ({
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
}))
// Read-only mounted reconciliation regression; not a discovery, pairing or grant test.
vi.mock('../../shared/api/runtimeIdentity', () => ({ useRuntimeIdentityQuery: () => ({ data: { installationId: fixture.mainId } }) }))
vi.mock('../../shared/api/computerSettings', () => ({
  useSelectedMainQuery: () => ({ isSuccess: true, data: { mainId: fixture.mainId, mainPublicKeyFingerprint: 'a'.repeat(64) } }),
  useRegisteredComputersQuery: () => ({ isSuccess: true, data: { devices: [{ mainId: fixture.mainId,
    deviceId: fixture.deviceId, workerInstallationId: fixture.deviceId, publicKeyFingerprint: 'b'.repeat(64),
    keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect'] }] } }),
  useHostHarnessRegistryQuery: () => ({ data: { instances: [], installations: [] } }),
}))
vi.mock('./HostHarnessOverrides', () => ({ HostHarnessOverrides: ({ target }: {
  target: { hostRef: CanonicalMachineReference; applicationInstallationId: string }
}) => <section aria-label="Host harness settings">{JSON.stringify(target)}</section> }))
vi.mock('./ComputerPairingForm', () => ({ ComputerPairingForm: () => null }))
vi.mock('./ComputerRevokeButton', () => ({ ComputerRevokeButton: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Computer inventory and settings sibling identities', () => {
  it.each(['main', 'device'] as const)('renders both %s sections without colliding child keys', (kind) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ComputerSettings deviceId={kind === 'device' ? fixture.deviceId : undefined} />)
    expect(screen.getByRole('region', { name: 'Host harness inventory' })).toBeVisible()
    const hostRef = kind === 'device' ? { kind, mainId: fixture.mainId, deviceId: fixture.deviceId }
      : { kind, mainId: fixture.mainId }
    expect(screen.getByRole('region', { name: 'Host harness settings' })).toHaveTextContent(JSON.stringify({
      hostRef, applicationInstallationId: kind === 'device' ? fixture.deviceId : fixture.mainId,
    }))
    expect(errors.mock.calls.filter(args => args.some(value => typeof value === 'string' && value.includes('same key')))).toEqual([])
  })
})
