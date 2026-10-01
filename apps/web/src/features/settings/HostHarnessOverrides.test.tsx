import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type { HostHarnessOverride } from '@graphql/contracts/harness-registry'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { HostHarnessOverrides } from './HostHarnessOverrides'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'
const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const pc: HostHarnessOverride = { instanceId: mainId, revision: 1, instanceRevision: 'pc-r1', target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'pc-installation', installationFingerprint: 'pc-fingerprint' },
  presetId: 'codex-default', enabled: true, driverId: 'codex', configuration: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'pc-model' }, configurationFingerprint: 'pc-config', qualification: 'unqualified' }
const laptop: HostHarnessOverride = { ...pc, instanceId: deviceId, instanceRevision: 'laptop-r1', target: { hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: deviceId, harnessInstallationId: 'laptop-installation', installationFingerprint: 'laptop-fingerprint' }, configuration: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'laptop-model' } }
beforeEach(() => server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [] }))))
const clients: QueryClient[] = []
function renderHost(value: HostHarnessOverride) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><HostHarnessOverrides key={value.instanceId} target={{ hostRef: value.target.hostRef, applicationInstallationId: value.target.applicationInstallationId }} /></QueryClientProvider>)
}
afterEach(() => { cleanup(); clearRevisionedFormPersistence(); for (const client of clients.splice(0)) client.clear() })
describe('host-specific settings revisions', () => {
  it('edits a Claude host profile without another provider or API-host model discovery', async () => {
    const claude: HostHarnessOverride = { ...pc, driverId: 'claude', presetId: 'claude-default', configuration: savedClaudeConfiguration }
    let catalogRequests = 0
    server.use(http.get('/api/management/harnesses/:harness/options', () => { catalogRequests += 1; return HttpResponse.json({}, { status: 503 }) }),
      http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [claude] })),
      http.post('/api/management/harness-instances/save', async ({ request }) => {
        const input = await request.json() as { expectedRevision: number; target: unknown; configuration: unknown }
        expect(input.expectedRevision).toBe(claude.revision); expect(input.target).toEqual(claude.target)
        expect(input.configuration).toEqual({ ...savedClaudeConfiguration, model: 'host-claude-model', configDirectory: '/host/claude/profile', authMode: 'api-key', sandbox: 'workspace-write' })
        return HttpResponse.json({ value: { ...claude, revision: 2, instanceRevision: 'claude-r2', configuration: input.configuration }, replayed: false })
      }))
    renderHost(claude)
    const user = userEvent.setup()
    const model = await screen.findByRole('textbox', { name: 'Model' })
    expect(screen.queryByLabelText('Provider variant')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Native Agent')).not.toBeInTheDocument()
    await user.clear(model); await user.type(model, 'host-claude-model')
    const profile = screen.getByRole('textbox', { name: 'Local Claude profile directory' })
    await user.clear(profile); await user.type(profile, '/host/claude/profile')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Authentication' }), 'api-key')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sandbox' }), 'workspace-write')
    await user.click(screen.getByRole('button', { name: 'Save host override' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(catalogRequests).toBe(0)
  })
  it('saves the exact installation and revision without calling API-host model discovery', async () => {
    server.use(http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [pc] })),
      http.post('/api/management/harness-instances/save', async ({ request }) => {
        const input = await request.json() as Record<string, unknown>
        expect(input.expectedRevision).toBe(1); expect(input.target).toEqual(pc.target)
        return HttpResponse.json({ value: { ...pc, revision: 2, instanceRevision: 'pc-r2', configuration: input.configuration }, replayed: false })
      }))
    renderHost(pc)
    const user = userEvent.setup(); const model = await screen.findByRole('textbox', { name: 'Model' })
    await user.clear(model); await user.type(model, 'pc-new-model'); await user.click(screen.getByRole('button', { name: 'Save host override' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(model).toHaveValue('pc-new-model')
  })
  it('preserves edits after a revision conflict and refreshes saved evidence', async () => {
    let changed = false
    server.use(http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [{ ...pc, revision: changed ? 2 : 1, instanceRevision: changed ? 'pc-r2' : 'pc-r1' }] })),
      http.post('/api/management/harness-instances/save', () => { changed = true; return HttpResponse.json({ error: { code: 'HARNESS_REVISION_CONFLICT', message: 'Instance changed elsewhere.' } }, { status: 409 }) }))
    renderHost(pc); const user = userEvent.setup()
    const model = await screen.findByRole('textbox', { name: 'Model' }); await user.clear(model); await user.type(model, 'unsaved-pc')
    await user.click(screen.getByRole('button', { name: 'Save host override' }))
    expect(await screen.findByText('These defaults changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(model).toHaveValue('unsaved-pc')
  })
  it('keeps a PC draft out of the laptop editor', async () => {
    server.use(http.post('/api/management/harness-instances/read', async ({ request }) => {
      const input = await request.json() as { hostRef: { kind: string } }
      return HttpResponse.json({ overrides: [input.hostRef.kind === 'main' ? pc : laptop] })
    }))
    const view = renderHost(pc); const user = userEvent.setup()
    const model = await screen.findByRole('textbox', { name: 'Model' }); await user.clear(model); await user.type(model, 'unsaved-pc')
    const client = clients[0]!
    await act(async () => { view.rerender(<QueryClientProvider client={client}><HostHarnessOverrides key={laptop.instanceId} target={{ hostRef: laptop.target.hostRef, applicationInstallationId: laptop.target.applicationInstallationId }} /></QueryClientProvider>) })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('laptop-model'))
    expect(screen.queryByDisplayValue('unsaved-pc')).not.toBeInTheDocument()
  })
})

describe('host override creation and complete editing', () => {
  it('creates against exact target inventory and reconciles the original command after an unknown acknowledgement', async () => {
    let saved: HostHarnessOverride | undefined
    const requests: unknown[] = []
    const installation = { ...pc.target, driverId: 'codex', driverRevision: 'driver1', protocolRevision: 'protocol1', environmentGeneration: 'env1', connectionGeneration: 'conn1', observedVersion: null,
      installed: true, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: 'codex', resolvedLauncher: '/pc/codex', fingerprint: 'launcher', status: 'installed', interpreter: null, diagnostics: [], environment: { generation: 'env1', provenance: 'gui', cwd: '/pc', path: '/pc' }, checkedAt: '2026-10-01T00:00:00.000Z' } }
    const { applicationInstallationId, ...inventoryInstallation } = installation
    expect(applicationInstallationId).toBe(mainId)
    server.use(http.get('/api/management/harnesses/registry', () => HttpResponse.json({ installations: [inventoryInstallation], instances: [{ instanceId: pc.presetId, instanceRevision: 'preset1', driverId: 'codex', enabled: true, configuration: pc.configuration, availability: 'available' }] })),
      http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: saved ? [saved] : [] })),
      http.post('/api/management/harness-instances/save', async ({ request }) => {
        const input = await request.json() as { instanceId: string; expectedRevision: number; configuration: HostHarnessOverride['configuration']; target: HostHarnessOverride['target'] }
        requests.push(input)
        expect(input.target).toEqual(pc.target); expect(input.expectedRevision).toBe(0)
        saved = { ...pc, instanceId: input.instanceId, configuration: input.configuration }
        if (requests.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Acknowledgement lost.' } }, { status: 503 })
        expect(requests[1]).toEqual(requests[0])
        return HttpResponse.json({ value: saved, replayed: true })
      }))
    renderHost(pc); const user = userEvent.setup()
    const choices = await screen.findByRole('combobox', { name: 'Installation and global preset for new override' })
    await waitFor(() => expect(choices.querySelectorAll('option')).toHaveLength(2))
    await user.selectOptions(choices, choices.querySelectorAll('option')[1]!.value)
    await user.click(screen.getByRole('button', { name: 'Configure new host override' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Web search' }), 'disabled')
    const shell = screen.getByRole('textbox', { name: 'Shell environment policy · JSON' })
    await user.clear(shell); await user.paste(JSON.stringify({ inherit: 'none', ignoreDefaultExcludes: false, filters: {}, set: { SAFE_FLAG: 'test' } }))
    await user.click(screen.getByRole('button', { name: 'Create host override' }))
    expect(await screen.findByText(/The previous save may have committed/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Create host override' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    await waitFor(() => expect(screen.getByText('Saved immutable revision').nextElementSibling).toHaveTextContent('pc-r1'))
    expect(saved?.configuration.harness === 'codex' && saved.configuration.advanced?.webSearch).toBe('disabled')
  })
})

it('checks a saved profile only on explicit action and reconciles its exact command after lost acknowledgement', async () => {
  const requests: unknown[] = []
  server.use(http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [pc] })),
    http.post('/api/management/harness-instances/check', async ({ request }) => {
      const input = await request.json() as { expectedRevision: number; target: HostHarnessOverride['target'] }
      requests.push(input)
      expect(input.expectedRevision).toBe(pc.revision); expect(input.target).toEqual(pc.target)
      if (requests.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Check acknowledgement lost.' } }, { status: 503 })
      expect(requests[1]).toEqual(requests[0])
      return HttpResponse.json({ value: pc, replayed: true, proof: { target: pc.target, instanceRevision: pc.instanceRevision, configurationFingerprint: pc.configurationFingerprint,
        driverId: pc.driverId, driverRevision: 'driver1', protocolRevision: 'protocol1', suiteRevision: 'suite-v1', environmentGeneration: 'env1', connectionGeneration: 'conn1',
        authenticated: false, compatible: true, qualified: false, checkedAt: '2026-10-01T00:00:00.000Z' } })
    }))
  renderHost(pc); const user = userEvent.setup()
  const button = await screen.findByRole('button', { name: 'Check saved profile on this computer' })
  expect(requests).toHaveLength(0)
  await user.click(button)
  expect(await screen.findByText('Check acknowledgement lost.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Reconcile original profile check' }))
  expect(await screen.findByText('suite-v1')).toBeVisible()
  expect(requests).toHaveLength(2)
})
