import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessRegistryReadbackSchema, type HostHarnessInstallationDto } from '@graphql/contracts/harness-registry'
import { HostHarnessInventory } from './HostHarnessInventory'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const installation: HostHarnessInstallationDto = {
  hostRef: { kind: 'main', mainId }, harnessInstallationId: 'pc-codex', installationFingerprint: 'pc-fingerprint',
  driverId: 'codex', driverRevision: '1', protocolRevision: '1', environmentGeneration: 'env-1', connectionGeneration: 'conn-1',
  observedVersion: '0.154.0', installed: true, authenticated: false, compatible: null, qualified: null,
  launcher: { requested: 'codex', resolvedLauncher: '/pc/bin/codex', fingerprint: 'launcher-fingerprint', status: 'installed',
    interpreter: null, diagnostics: [], environment: { generation: 'env-1', provenance: 'gui', cwd: '/pc', path: '/pc/bin' },
    checkedAt: '2026-10-01T00:00:00.000Z' },
}
afterEach(cleanup)
describe('host installation evidence', () => {
  it('keeps installed, authenticated and unknown capability observations independent', () => {
    render(<HostHarnessInventory host={{ kind: 'main', mainId }} registry={HarnessRegistryReadbackSchema.parse({ instances: [], installations: [installation] })} />)
    expect(screen.getByText('Installed').nextElementSibling).toHaveTextContent('Yes')
    expect(screen.getByText('Authenticated').nextElementSibling).toHaveTextContent('No')
    expect(screen.getByText('Compatible').nextElementSibling).toHaveTextContent('Unknown')
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
  })
  it('reports absent fingerprint and unknown permitted roots without creating positive evidence', () => {
    render(<HostHarnessInventory host={{ kind: 'main', mainId }} registry={HarnessRegistryReadbackSchema.parse({
      hostMetadata: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, connection: null, platform: null, workspaceRoots: null }, instances: [],
      installations: [{ ...installation, installed: false, installationFingerprint: null }],
    })} />)
    expect(screen.getByText('Fingerprint').nextElementSibling).toHaveTextContent('Unavailable')
    expect(screen.getByText('Installed').nextElementSibling).toHaveTextContent('No')
    expect(screen.getByText('Root policy readback is unknown or restricted. No permitted roots are inferred.')).toBeVisible()
    expect(screen.queryByText('No permitted workspace roots were returned.')).not.toBeInTheDocument()
  })
  it('does not substitute PC records after selecting the laptop or a different main', async () => {
    const registry = { instances: [], installations: [installation] }
    const view = render(<HostHarnessInventory host={{ kind: 'main', mainId }} registry={registry} />)
    await userEvent.click(screen.getByText('Installation details'))
    expect(screen.getByText('pc-fingerprint')).toBeVisible()
    view.rerender(<HostHarnessInventory host={{ kind: 'device', mainId, deviceId }} registry={registry} />)
    expect(screen.queryByText('pc-fingerprint')).not.toBeInTheDocument()
    expect(screen.getByText('No harness installation evidence was returned for this computer.')).toBeVisible()
    view.rerender(<HostHarnessInventory host={{ kind: 'main', mainId: deviceId }} registry={registry} />)
    expect(screen.queryByText('pc-fingerprint')).not.toBeInTheDocument()
  })
  it('keeps invalid configured instances reachable without exposing raw configuration', async () => {
    render(<HostHarnessInventory host={{ kind: 'main', mainId }} registry={{ installations: [], instances: [{ instanceId: 'unknown-instance', instanceRevision: 'r1', driverId: 'unknown', enabled: true, configuration: null, availability: 'unknown-driver' }] }} />)
    await userEvent.click(screen.getByText(/^Global defaults/))
    expect(screen.getByText('unknown-driver')).toBeVisible()
    expect(screen.getByText(/unknown-instance/)).toBeVisible()
  })
})
