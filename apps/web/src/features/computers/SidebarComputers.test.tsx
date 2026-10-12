import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { onlineManager } from '@tanstack/react-query'
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { resourceTelemetryFixtures } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { telemetrySelectorKey, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { server } from '../../mocks/server'
import { SidebarComputers } from './SidebarComputers'
import { computerReadHandler, computersFixture, deviceId, deviceName, deviceTarget, mainId, mainTarget, registration } from './computersTestFixture'

function inRouter() {
  const root = createRootRoute({ component: Outlet })
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', component: SidebarComputers }),
    createRoute({ getParentRoute: () => root, path: '/settings/computers', component: () => <h1>Computers settings</h1> }),
    createRoute({ getParentRoute: () => root, path: '/settings/computers/$deviceId', component: () => <h1>Computer details</h1> }),
  ]) })
  return { router, element: <RouterProvider router={router} /> }
}
function cpuReading(percent: number) {
  const sample = structuredClone(resourceTelemetryFixtures.computerZero!)
  if (sample.kind !== 'sample' || sample.sample.cpu.state !== 'fresh') throw new Error('Expected a fresh sample fixture')
  const selector: TelemetrySelector = { ...sample.sample.selector, host: { ...sample.sample.selector.host,
    applicationInstallationId: mainTarget.applicationInstallationId } }
  sample.sample.selector = selector
  sample.sample.identity.host = selector.host
  sample.sample.selectorKey = telemetrySelectorKey(selector)
  sample.sample.cpu.value.hostCapacityPercent = percent
  sample.lastKnown = null
  return [http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'selector', selector })),
    http.post('*/api/management/resource-telemetry/read', () => HttpResponse.json(sample))]
}
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
const cancelAnimation = vi.fn()
const animate = vi.fn(() => ({ cancel: cancelAnimation }))
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate }))
beforeEach(() => {
  animate.mockClear()
  cancelAnimation.mockClear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => {
  onlineManager.setOnline(true)
  vi.unstubAllGlobals()
})
afterAll(() => {
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})

it('shows each computer as an icon-only button whose load is named in words and colored by level', async () => {
  const f = computersFixture(inRouter().element)
  const main = await screen.findByRole('button', { name: 'Main PC, Main, Plenty of capacity' })
  expect(main.closest('li')).toHaveAttribute('data-load', 'calm')
  const device = screen.getByRole('button', { name: `${deviceName}, Worker, Offline` })
  expect(device.closest('li')).toHaveAttribute('data-load', 'offline')
  expect(device.textContent).toBe('')
  f.activity.computers[0]!.agents.push({ id: 'execution-1', workspaceId: 'workspace-1', workflowId: 'workflow-1',
    workflowName: 'Release', runId: 'run-1', nodeId: 'review', agentName: 'Reviewer', state: 'waiting' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByRole('button', { name: 'Main PC, Main, Some load, 1 running Agent or CI job' })).toHaveTextContent(/^1$/)
})
it('derives the level from live CPU and shows the reading in the detail card', async () => {
  computersFixture(inRouter().element, cpuReading(95))
  const main = await screen.findByRole('button', { name: 'Main PC, Main, Near its limits' })
  expect(main.closest('li')).toHaveAttribute('data-load', 'saturated')
  act(() => main.focus())
  expect(await within(await screen.findByRole('tooltip')).findByRole('meter', { name: 'CPU' })).toBeInTheDocument()
})
it('shows a detail card on hover with role, load, utilization, running work and versions', async () => {
  const f = computersFixture(inRouter().element, [computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: {
    harnesses: [{ harness: 'codex', installed: true, version: '0.162.1', latest: '0.162.1' },
      { harness: 'claude', installed: false, version: null, latest: null }],
    system: { packageUpdates: 0, rebootRequired: false, sudo: true, disk: null }, tasks: [], observedAt: new Date().toISOString() } }] })])
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  for (const index of [1, 2, 3, 4]) f.activity.computers[0]!.agents.push({ id: `execution-${index}`, workspaceId: 'workspace-1',
    workflowId: 'workflow-1', workflowName: 'Release', runId: 'run-1', nodeId: `node-${index}`, agentName: `Agent ${index}`, state: 'running' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const user = userEvent.setup()
  const main = await screen.findByRole('button', { name: 'Main PC, Main, Some load, 5 running Agents and CI jobs' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  await user.hover(main)
  const card = await screen.findByRole('tooltip')
  expect(main).toHaveAttribute('aria-describedby', card.id)
  expect(within(card).getByText('Main')).toBeInTheDocument()
  expect(within(card).getByText('Online · Some load')).toBeInTheDocument()
  expect(within(card).getByRole('meter', { name: 'CPU' })).toBeInTheDocument()
  const agents = within(card).getByRole('region', { name: 'Agents' })
  expect(within(agents).getByText('4')).toBeInTheDocument()
  expect(within(agents).getByText('Agent 1 · Release')).toBeInTheDocument()
  expect(within(agents).queryByText('Agent 4 · Release')).not.toBeInTheDocument()
  expect(within(agents).getByText('and 1 more')).toBeInTheDocument()
  expect(within(within(card).getByRole('region', { name: 'CI jobs' })).getByText('Web build · Store')).toBeInTheDocument()
  expect(await within(card).findByText('0.162.1')).toBeInTheDocument()
  expect(within(card).getByText('Not installed')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
})
it('opens the card on keyboard focus with a Worker last seen time and app version, and links to its settings', async () => {
  const lastSeenAt = new Date(Date.now() - 125_000).toISOString()
  const { router, element } = inRouter()
  computersFixture(element, [
    computerReadHandler('maintenance', { computers: [{ target: deviceTarget, status: {
      worker: { currentVersion: '9.9.1', targetVersion: null, state: 'current', lastError: null }, harnesses: [],
      system: { packageUpdates: 0, rebootRequired: false, sudo: true, disk: null }, tasks: [], observedAt: lastSeenAt } }] }),
    http.get('*/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [], hostMetadata: {
      hostRef: deviceTarget.hostRef, applicationInstallationId: registration.workerInstallationId, platform: null, workspaceRoots: null,
      connection: { binding: { mainId, deviceId, workerInstallationId: registration.workerInstallationId,
        bootId: '44444444-4444-4444-8444-444444444444', keyRevision: 1, authorizationRevision: 1, connectionGeneration: 2,
        connectionEpoch: '55555555-5555-4555-8555-555555555555' },
      phase: 'offline', dispatch: false, transfer: false, appVersion: '9.9.0', protocolVersion: 1, lastSeenAt } } })),
  ])
  await screen.findByRole('button', { name: `${deviceName}, Worker, Offline` })
  const user = userEvent.setup()
  await user.tab()
  await user.tab()
  const card = await screen.findByRole('tooltip')
  expect(within(card).getByText('Worker')).toBeInTheDocument()
  expect(await within(card).findByText('· last seen 2 min ago')).toBeInTheDocument()
  expect(await within(card).findByText('9.9.1')).toBeInTheDocument()
  expect(within(card).queryByRole('meter')).not.toBeInTheDocument()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(router.state.location.pathname).toBe(`/settings/computers/${deviceId}`))
})
it('stops presenting load as current while activity reads fail or the browser is offline', async () => {
  const f = computersFixture(inRouter().element)
  await screen.findByRole('button', { name: 'Main PC, Main, Plenty of capacity' })
  act(() => onlineManager.setOnline(false))
  expect(screen.getByRole('button', { name: 'Main PC, Main, Status unknown' }).closest('li')).toHaveAttribute('data-load', 'unknown')
  act(() => onlineManager.setOnline(true))
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({
    error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })))
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByRole('button', { name: 'Main PC, Main, Status unknown' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: `${deviceName}, Worker, Status unknown` })).toBeInTheDocument()
})
it('shows cloud CI services by machines in use', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push({ provider: 'github', name: 'GitHub Actions', ready: true, slots: 16, running: 12 },
    { provider: 'circleci', name: 'CircleCI', ready: false, slots: 24, running: 0 })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const github = await screen.findByRole('button', { name: 'GitHub Actions, Cloud CI, Heavy load, 12 running Agents and CI jobs' })
  const circle = screen.getByRole('button', { name: 'CircleCI, Cloud CI, Not logged in on Main' })
  expect(circle.closest('li')).toHaveAttribute('data-load', 'offline')
  await userEvent.setup().hover(github)
  expect(await within(await screen.findByRole('tooltip')).findByText('12 of 16 CI machines in use')).toBeInTheDocument()
})

it('counts Agents and CI jobs, caps the badge, and pulses on starts including a replacement at the same count', async () => {
  const f = computersFixture(inRouter().element)
  const main = await screen.findByRole('button', { name: 'Main PC, Main, Plenty of capacity' })
  const computer = f.activity.computers[0]!
  expect(animate).not.toHaveBeenCalled()
  expect(within(main).queryByText('1')).not.toBeInTheDocument()
  computer.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByRole('button', { name: 'Main PC, Main, Some load, 1 running Agent or CI job' })).toBe(main)
  expect(within(main).getByText('1')).toBeInTheDocument()
  expect(animate).toHaveBeenCalledTimes(1)
  expect(animate).toHaveBeenLastCalledWith([
    { transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' },
  ], { duration: 300, easing: 'ease-out' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(animate).toHaveBeenCalledTimes(1)
  computer.jobs[0]!.id = 'job-2'
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(animate).toHaveBeenCalledTimes(2)
  for (let index = 0; index < 9; index++) computer.agents.push({ id: `execution-${index}`, workspaceId: 'workspace-1',
    workflowId: 'workflow-1', workflowName: 'Release', runId: 'run-1', nodeId: `node-${index}`, agentName: `Agent ${index}`, state: 'running' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByRole('button', { name: 'Main PC, Main, Heavy load, 10 running Agents and CI jobs' })).toBe(main)
  expect(within(main).getByText('9+')).toBeInTheDocument()
  expect(animate).toHaveBeenCalledTimes(3)
  computer.agents = []
  computer.jobs = []
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByRole('button', { name: 'Main PC, Main, Plenty of capacity' })).toBe(main)
  expect(within(main).queryByText('9+')).not.toBeInTheDocument()
  expect(animate).toHaveBeenCalledTimes(3)
})
it('hides activity indicators when offline or stale even if the last observation has running work', async () => {
  const f = computersFixture(inRouter().element)
  await screen.findByRole('button', { name: 'Main PC, Main, Plenty of capacity' })
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const main = await screen.findByRole('button', { name: 'Main PC, Main, Some load, 1 running Agent or CI job' })
  act(() => onlineManager.setOnline(false))
  expect(main).toHaveAccessibleName('Main PC, Main, Status unknown')
  expect(within(main).queryByText('1')).not.toBeInTheDocument()
  act(() => onlineManager.setOnline(true))
  f.activity.computers[0]!.online = false
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await screen.findByRole('button', { name: 'Main PC, Main, Offline' })).toBe(main)
  expect(within(main).queryByText('1')).not.toBeInTheDocument()
})
it('keeps the running badge and skips the start pulse when reduced motion is preferred', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const f = computersFixture(inRouter().element)
  await screen.findByRole('button', { name: 'Main PC, Main, Plenty of capacity' })
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const main = await screen.findByRole('button', { name: 'Main PC, Main, Some load, 1 running Agent or CI job' })
  expect(within(main).getByText('1')).toBeInTheDocument()
  expect(animate).not.toHaveBeenCalled()
})
