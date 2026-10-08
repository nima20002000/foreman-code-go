import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HostHarnessOverrideSaveSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { server } from '../../mocks/server'
import { HarnessSettingsRouteEntry } from '../../routes/SettingsExperienceRoutes'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { HarnessComputerSearchSchema } from './harnessComputerSearch'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'
import { AppNavigationTrail } from '../../shared/ui/AppNavigationTrail'

vi.mock('../../shared/ui/WorkspaceShell', () => ({ WorkspaceShell: ({ slots }: { slots: { main: unknown } }) => <><AppNavigationTrail />{slots.main}</> }))
const mainId = '11111111-1111-4111-8111-111111111111'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clearRevisionedFormPersistence(); clients.splice(0).forEach(client => client.clear()) })
function setup(pending = false) {
  let saved: HostHarnessOverride = { instanceId: mainId, revision: 1, instanceRevision: '1', target: { hostRef: { kind: 'main', mainId },
    applicationInstallationId: mainId, harnessInstallationId: 'installed-claude', installationFingerprint: 'fingerprint' },
    presetId: 'owned-test-profile', enabled: false, driverId: 'claude', configuration: savedClaudeConfiguration,
    configurationFingerprint: 'saved-fingerprint', qualification: 'disabled' }
  let acknowledge!: () => void
  const held = new Promise<void>(resolve => { acknowledge = resolve })
  let requests = 0
  server.use(
    http.get('/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'public', mainPublicKeyFingerprint: 'a'.repeat(64) })),
    http.get('/api/devices', () => HttpResponse.json({ devices: [] })),
    http.get('/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [] })),
    http.get('/api/management/harnesses', () => HttpResponse.json((['codex'] as const).map(harness => ({ harness,
      defaults: DEFAULT_HARNESS_DEFAULTS[harness], defaultsRevision: 1, capability: null, discoveryError: null })))),
    http.post('/api/management/harness-instances/read', () => HttpResponse.json({ overrides: [saved] })),
    http.post('/api/management/harness-instances/save', async ({ request }) => {
      const input = HostHarnessOverrideSaveSchema.parse(await request.json()); requests += 1
      if (pending) await held
      saved = { ...saved, configuration: input.configuration, revision: saved.revision + 1, instanceRevision: String(saved.revision + 1) }
      return HttpResponse.json({ value: saved, replayed: false })
    }),
  )
  const root = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const harnesses = createRoute({ getParentRoute: () => root, path: '/settings/harnesses', validateSearch: HarnessComputerSearchSchema,
    component: HarnessSettingsRouteEntry })
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: () => <p>Settings</p> })
  const router = createRouter({ routeTree: root.addChildren([harnesses, settings]),
    history: createMemoryHistory({ initialEntries: ['/settings/harnesses?harness=claude&section=model&computer=main'] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, requests: () => requests, acknowledge, held }
}
it('returns to the Harnesses overview from the breadcrumb after an acknowledged computer-profile save', async () => {
  const f = setup()
  const user = userEvent.setup()
  const model = await screen.findByRole('textbox', { name: 'Model' })
  await user.clear(model); await user.type(model, 'saved-host-model')
  await user.click(screen.getByRole('button', { name: 'Save host override' }))
  expect(await screen.findByText('Changes saved to the server')).toBeVisible()
  await user.click(screen.getByRole('link', { name: 'Go to Harnesses' }))
  expect(await screen.findByRole('heading', { name: 'Harnesses' })).toBeVisible()
  expect(f.router.state.location.search).toEqual({})
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(f.requests()).toBe(1)
})
it('keeps pending saves and newer edits protected when the Harnesses breadcrumb is clicked', async () => {
  const f = setup(true)
  const user = userEvent.setup()
  const model = await screen.findByRole('textbox', { name: 'Model' })
  await user.clear(model); await user.type(model, 'submitted-host-model')
  await user.click(screen.getByRole('button', { name: 'Save host override' }))
  await waitFor(() => expect(f.requests()).toBe(1))
  await user.clear(model); await user.type(model, 'newer-unsaved-host-model')
  await user.click(screen.getByRole('link', { name: 'Go to Harnesses' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  expect(f.router.state.location.search.computer).toBe('main')
  await act(async () => { f.acknowledge(); await f.held })
  expect(await screen.findByText('Earlier changes saved')).toBeVisible()
  expect(model).toHaveValue('newer-unsaved-host-model')
  expect(dialog).toBeVisible()
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeEnabled())
  await user.click(within(dialog).getByRole('button', { name: 'Discard' }))
  expect(await screen.findByRole('heading', { name: 'Harnesses' })).toBeVisible()
  expect(f.router.state.location.search).toEqual({})
})
