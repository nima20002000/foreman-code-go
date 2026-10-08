import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HostHarnessOverrideSaveSchema, HostHarnessInstanceCheckInputSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ToastProvider } from '../../shared/ui/nocturne/ToastProvider'
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
function deferredReadback() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function renderHost(value: HostHarnessOverride) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><ToastProvider>
    <HostHarnessOverrides key={value.instanceId} target={{ hostRef: value.target.hostRef,
      applicationInstallationId: value.target.applicationInstallationId }} />
  </ToastProvider></QueryClientProvider>)
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
        expect(input.configuration).toEqual({ ...savedClaudeConfiguration, model: 'host-claude-model', configDirectory: '/host/claude/profile', authMode: 'api-key', sandbox: 'danger-full-access' })
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sandbox' }), 'danger-full-access')
    await user.click(screen.getByRole('button', { name: 'Save host override' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(catalogRequests).toBe(0)
  })
  it('saves the exact installation and revision without reporting its own readback as a conflict', async () => {
    let saved = pc
    const readback = deferredReadback()
    server.use(
      http.get('/api/management/harnesses/registry', async () => {
        if (saved.revision > 1) await readback.promise
        return HttpResponse.json({ instances: [], installations: [] })
      }),
      http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [saved] })),
      http.post('/api/management/harness-instances/save', async ({ request }) => {
        const input = HostHarnessOverrideSaveSchema.parse(await request.json())
        expect(input.expectedRevision).toBe(1); expect(input.target).toEqual(pc.target)
        saved = { ...pc, revision: 2, instanceRevision: 'pc-r2', configuration: input.configuration }
        return HttpResponse.json({ value: saved, replayed: false })
      }))
    renderHost(pc)
    const user = userEvent.setup()
    const model = await screen.findByRole('textbox', { name: 'Model' })
    await user.clear(model)
    await user.type(model, 'pc-new-model')
    await user.click(screen.getByRole('button', { name: 'Save host override' }))
    await waitFor(() => expect(screen.getByText('Saved immutable revision').nextElementSibling).toHaveTextContent('pc-r2'))
    expect(screen.getByRole('button', { name: 'Save host override' })).toHaveTextContent('Saving…')
    readback.release()
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(await screen.findByText('Host override saved')).toBeVisible()
    expect(screen.getByText('Saved immutable revision').nextElementSibling).toHaveTextContent('pc-r2')
    expect(screen.queryByText('Host override changed elsewhere')).not.toBeInTheDocument()
    expect(screen.queryByText('These defaults changed elsewhere. Your edits are preserved.')).not.toBeInTheDocument()
    expect(model).toHaveValue('pc-new-model')
  })
  it('warns about an external revision and requires review before saving the retained draft', async () => {
    let saved = pc
    const revisions: number[] = []
    server.use(
      http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [saved] })),
      http.post('/api/management/harness-instances/save', async ({ request }) => {
        const input = HostHarnessOverrideSaveSchema.parse(await request.json())
        revisions.push(input.expectedRevision)
        saved = { ...saved, revision: 3, instanceRevision: 'pc-r3', configuration: input.configuration }
        return HttpResponse.json({ value: saved, replayed: false })
      }),
    )
    renderHost(pc)
    const user = userEvent.setup()
    const model = await screen.findByRole('textbox', { name: 'Model' })
    await user.clear(model)
    await user.type(model, 'my-draft')
    saved = { ...pc, revision: 2, instanceRevision: 'pc-r2', enabled: false,
      configuration: { ...pc.configuration, model: 'external-model' } }
    await act(async () => { await clients[0]!.invalidateQueries() })
    expect(await screen.findByText('Host override changed elsewhere')).toBeVisible()
    expect(screen.getByText('These defaults changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(model).toHaveValue('my-draft')
    expect(screen.getByRole('button', { name: 'Save host override' })).toBeDisabled()
    expect(revisions).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Reapply my edits to current defaults' }))
    expect(model).toHaveValue('my-draft')
    expect(screen.getByRole('checkbox', { name: 'Enabled for new admissions' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Save host override' }))
    expect(await screen.findByText('Changes saved to the server')).toBeVisible()
    expect(revisions).toEqual([2])
  })
  it('reports a concurrent revision after the save settles and preserves edits made during saving', async () => {
    let latest = pc
    const readback = deferredReadback()
    server.use(
      http.get('/api/management/harnesses/registry', async () => {
        if (latest.revision > 1) await readback.promise
        return HttpResponse.json({ instances: [], installations: [] })
      }),
      http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [latest] })),
      http.post('/api/management/harness-instances/save', async ({ request }) => {
        const input = HostHarnessOverrideSaveSchema.parse(await request.json())
        const saved = { ...pc, revision: 2, instanceRevision: 'pc-r2', configuration: input.configuration }
        latest = { ...saved, revision: 3, instanceRevision: 'pc-r3',
          configuration: { ...saved.configuration, model: 'external-model' } }
        return HttpResponse.json({ value: saved, replayed: false })
      }),
    )
    renderHost(pc)
    const user = userEvent.setup()
    const model = await screen.findByRole('textbox', { name: 'Model' })
    await user.clear(model)
    await user.type(model, 'submitted-model')
    await user.click(screen.getByRole('button', { name: 'Save host override' }))
    await waitFor(() => expect(screen.getByText('Saved immutable revision').nextElementSibling).toHaveTextContent('pc-r3'))
    await user.clear(model)
    await user.type(model, 'newer-draft')
    readback.release()
    expect(await screen.findByText('Earlier changes saved')).toBeVisible()
    expect(await screen.findByText('Host override changed elsewhere')).toBeVisible()
    expect(screen.getByText('These defaults changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(model).toHaveValue('newer-draft')
    expect(screen.getByRole('button', { name: 'Save host override' })).toBeDisabled()
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
    expect(choices.querySelectorAll('option')[1]).toHaveTextContent('codex · codex-default')
    expect(choices.querySelectorAll('option')[1]).not.toHaveTextContent('pc-installation')
    await user.selectOptions(choices, choices.querySelectorAll('option')[1]!.value)
    await user.click(screen.getByText('Selected installation and preset'))
    expect(screen.getByText('Installation fingerprint').nextElementSibling).toHaveTextContent('pc-fingerprint')
    expect(screen.getByText('Preset revision').nextElementSibling).toHaveTextContent('preset1')
    await user.click(screen.getByRole('button', { name: 'Configure new host override' }))
    expect(screen.getAllByText(/Saving does not qualify/)).toHaveLength(1)
    expect(screen.queryByText(/These are explicit configuration values/)).not.toBeInTheDocument()
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


it('creates a Claude override from its saved preset, edits the profile directory and explicitly checks persisted settings', async () => {
  let saved: HostHarnessOverride | undefined
  let checks = 0
  const readback = deferredReadback()
  const target = { ...pc.target, harnessInstallationId: 'claude-sdk', installationFingerprint: 'claude-payload' }
  server.use(
    http.get('/api/management/harnesses/registry', async () => {
      if (saved) await readback.promise
      return HttpResponse.json({
        instances: [{ instanceId: 'local-default:claude', instanceRevision: '5', driverId: 'claude',
          enabled: true, configuration: savedClaudeConfiguration, availability: 'available', driverRevision: '1' }],
        installations: [{ hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
          installationFingerprint: target.installationFingerprint, driverId: 'claude', driverRevision: '1',
          protocolRevision: 'claude-sdk', environmentGeneration: 'env', connectionGeneration: 'conn',
          installed: true, authenticated: null, compatible: null, qualified: null, observedVersion: null,
          launcher: { requested: 'claude', resolvedLauncher: '/host/claude', fingerprint: 'claude-payload',
            status: 'installed', interpreter: null, diagnostics: [], checkedAt: '2026-10-01T00:00:00.000Z',
            environment: { generation: 'env', provenance: 'terminal', cwd: '/host', path: '/host' } } }],
      })
    }),
    http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: saved ? [saved] : [] })),
    http.post('/api/management/harness-instances/save', async ({ request }) => {
      const input = HostHarnessOverrideSaveSchema.parse(await request.json())
      expect(input).toMatchObject({ expectedRevision: 0, target, presetId: 'local-default:claude',
        configuration: { ...savedClaudeConfiguration, configDirectory: '/host/different-profile' } })
      saved = { ...pc, instanceId: input.instanceId, target: input.target, presetId: input.presetId,
        enabled: input.enabled, configuration: input.configuration,
        revision: 1, instanceRevision: '1', driverId: 'claude',
        configurationFingerprint: 'saved-claude', qualification: 'unqualified' }
      return HttpResponse.json({ value: saved, replayed: false })
    }),
    http.post('/api/management/harness-instances/check', async ({ request }) => {
      const input = HostHarnessInstanceCheckInputSchema.parse(await request.json())
      expect(input).toMatchObject({ instanceId: saved!.instanceId, expectedRevision: 1, target })
      expect(saved!.configuration).toMatchObject({ configDirectory: '/host/different-profile' })
      checks += 1
      saved = { ...saved!, qualification: 'qualified' }
      return HttpResponse.json({ value: saved, replayed: false, proof: {
        target, instanceRevision: '1', configurationFingerprint: 'saved-claude', driverId: 'claude',
        driverRevision: '1', protocolRevision: 'claude-sdk', suiteRevision: 'profile-suite',
        environmentGeneration: 'env', connectionGeneration: 'conn', authenticated: true,
        compatible: true, qualified: true, checkedAt: '2026-10-01T00:00:00.000Z',
      } })
    }),
  )
  renderHost(pc)
  const user = userEvent.setup()
  const choices = await screen.findByRole('combobox', { name: 'Installation and global preset for new override' })
  await waitFor(() => expect(choices.querySelectorAll('option')).toHaveLength(2))
  expect(choices.querySelectorAll('option')[1]).toHaveTextContent('claude')
  await user.selectOptions(choices, choices.querySelectorAll('option')[1]!.value)
  await user.click(screen.getByRole('button', { name: 'Configure new host override' }))
  const profile = screen.getByRole('textbox', { name: 'Local Claude profile directory' })
  await user.clear(profile)
  await user.type(profile, '/host/different-profile')
  expect(screen.queryByRole('button', { name: 'Check saved profile on this computer' })).not.toBeInTheDocument()
  expect(checks).toBe(0)
  await user.click(screen.getByRole('button', { name: 'Create host override' }))
  const check = await screen.findByRole('button', { name: 'Check saved profile on this computer' })
  expect(check).toBeDisabled()
  readback.release()
  await waitFor(() => expect(check).toBeEnabled())
  expect(screen.getByText('Changes saved to the server')).toBeVisible()
  expect(screen.queryByText(/host override changed elsewhere/i)).not.toBeInTheDocument()
  expect(screen.queryByText('These defaults changed elsewhere. Your edits are preserved.')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Local Claude profile directory' })).toHaveValue('/host/different-profile')
  expect(screen.getByText(/subscription capacity/)).toBeVisible()
  expect(checks).toBe(0)
  await user.click(check)
  await waitFor(() => expect(screen.getByText('Qualification').nextElementSibling).toHaveTextContent('qualified'))
  expect(checks).toBe(1)
})
