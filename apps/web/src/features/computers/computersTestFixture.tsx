import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { http, HttpResponse, type HttpHandler } from 'msw'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { BuildComputerStatus, BuildComputerUpdate, BuildComputerBatchUpdate } from '@foreman-code/contracts/build-computers'
import type { ComputerActivityList } from '@foreman-code/contracts/computer-activity'
import type { ComputerAccountsList } from '@foreman-code/contracts/computer-accounts'
import { server } from '../../mocks/server'
import { computerKey } from '../../shared/api/computerActivity'
import { useComputerUi } from './computerUiStore'

export const mainId = '11111111-1111-4111-8111-111111111111'
export const deviceId = '22222222-2222-4222-8222-222222222222'
export const deviceName = 'Computer 22222222'
export const registration: DeviceRegistration = { mainId, deviceId,
  workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1,
  status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
export const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
export const deviceTarget = { hostRef: { kind: 'device' as const, mainId, deviceId },
  applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }

export function computersFixture(children: React.ReactNode, handlers: HttpHandler[] = []) {
  useComputerUi.setState({ activity: undefined, draggedKey: undefined, github: undefined, sync: undefined })
  const statuses = new Map<string, BuildComputerStatus>([mainTarget, deviceTarget].map((target, index) => [
    computerKey(target), { preference: { target, revision: 1, buildEnabled: true, buildPriority: 100 - index * 50,
      buildRole: index ? 'backup' : 'primary', buildAllowancePercent: 60 },
    state: 'ready', reasons: [], remoteExecutionEnabled: true },
  ]))
  const activity: ComputerActivityList = { mainId, activityComplete: true, truncated: false,
    computers: [mainTarget, deviceTarget].map((target, index) => ({ target, name: index ? deviceName : 'Main PC',
      online: !index, jobs: [], agents: [] })) }
  const accounts: ComputerAccountsList = { computers: [
    { target: mainTarget, accounts: { observedAt: new Date().toISOString(), accounts: [
      { tool: 'codex', installed: true, signedIn: true, account: 'coder@example.com', details: ['ChatGPT'] },
      { tool: 'claude', installed: true, signedIn: false, account: null, details: [] },
      { tool: 'github', installed: true, signedIn: true, account: 'octo-owner', details: [] },
    ] } },
    { target: deviceTarget, accounts: null },
  ] }
  const writes: BuildComputerUpdate[] = []
  const batches: BuildComputerBatchUpdate[] = []
  const update = (input: BuildComputerUpdate) => {
    const before = statuses.get(computerKey(input.target))!
    const preference = { ...before.preference, revision: before.preference.revision + 1,
      buildPriority: input.buildPriority, buildEnabled: input.buildEnabled,
      buildRole: input.buildRole ?? before.preference.buildRole,
      buildAllowancePercent: input.buildAllowancePercent ?? before.preference.buildAllowancePercent }
    const status = { ...before, preference }
    statuses.set(computerKey(input.target), status)
    return status
  }
  server.use(...handlers,
    http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
      const { target } = await request.json() as BuildComputerUpdate
      return HttpResponse.json(statuses.get(computerKey(target)))
    }),
    http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
      const input = await request.json() as BuildComputerUpdate
      writes.push(input)
      return HttpResponse.json(update(input))
    }),
    http.post('*/api/management/settings/build-computers/batch-update', async ({ request }) => {
      const input = await request.json() as BuildComputerBatchUpdate
      batches.push(input)
      if (input.updates.some(change => statuses.get(computerKey(change.target))?.preference.revision !== change.expectedRevision)) {
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed elsewhere' } }, { status: 409 })
      }
      const changes = input.updates.map(change => ({ ...change, commandId: input.commandId }))
      writes.push(...changes)
      return HttpResponse.json({ computers: changes.map(update) })
    }),
    http.get('*/api/management/computers/activity', () => HttpResponse.json(activity)),
    http.get('*/api/management/computers/accounts', () => HttpResponse.json(accounts)),
    http.post('*/api/management/computers/sync/status', async ({ request }) => {
      const { target } = await request.json() as { target: typeof mainTarget }
      return HttpResponse.json({ target, installed: false, running: false, message: null, folders: [] })
    }),
    http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'unavailable' })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const rendered = render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  return { client, rendered, statuses, activity, writes, batches, update }
}
