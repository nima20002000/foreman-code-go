import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { JobRuntimeApprovalSchema, JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { server } from '../../mocks/server'
import { profile, approval, verificationProfile } from '../../test/jobRuntimeFixture'
import { ComputerRuntimeApprovals } from './ComputerRuntimeApprovals'

const deviceId = '22222222-2222-4222-8222-222222222222', mainId = '11111111-1111-4111-8111-111111111111'
const registration: DeviceRegistration = { mainId, deviceId, workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1,
  publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
const host = { kind: 'device' as const, mainId, deviceId }, pins = { workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1 }
const root = { ...profile.root, selection: { ...profile.root.selection, hostRef: host }, registration: pins,
  binding: { ...profile.root.binding, deviceId, workerInstallationId: deviceId } }
const deviceProfile = JobRuntimeProfileSchema.parse({ ...profile, root })
const deviceApproval = JobRuntimeApprovalSchema.parse({ ...approval, fingerprint: { ...approval.fingerprint, root, hostRef: host, registration: pins } })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><ComputerRuntimeApprovals registration={registration} /></QueryClientProvider>)
}
function handlers(pending = deviceApproval) {
  const base = `/api/management/workspaces/${profile.workspaceId}/jobs`
  server.use(http.get('/api/management/workspaces', () => HttpResponse.json({ items: [{ workspace: { id: profile.workspaceId, name: 'Acceptance workspace', agentIds: [], workflowIds: [], createdAt: profile.createdAt, updatedAt: profile.updatedAt },
    revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } }], pageInfo: { nextCursor: null } })),
  http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: deviceProfile, ready: false, reasons: [], sideEffects: false }], approvals: [pending] })))
  return base
}
it('shows why verification is pending owner review without offering an approval or implying qualification', async () => {
  const base = handlers()
  const pending = JobVerificationProfileSchema.parse({ ...verificationProfile, root })
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: pending,
    ready: false, reasons: ['approval_review_required'], sideEffects: false }], approvals: [] })))
  renderPanel()
  expect(await screen.findByRole('heading', { name: pending.name })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('waiting for the owner to review')
  expect(screen.getByText('install, unit')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  expect(screen.queryByText('Approved for physical qualification')).not.toBeInTheDocument()
})
it('shows the pending exact fingerprint and approves through the real browser POST with persisted readback', async () => {
  let pending = deviceApproval
  const base = handlers(), user = userEvent.setup()
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: deviceProfile, ready: false, reasons: [], sideEffects: false }], approvals: [pending] })),
    http.post(`${base}/runtime-qualifications/${deviceApproval.id}/approve`, async ({ request }) => {
      expect(request.credentials).toBe('same-origin')
      expect(await request.json()).toEqual({ commandId: expect.any(String) })
      pending = { ...pending, status: 'approved', approvedByPrincipalId: 'browser-human', approvedAt: new Date().toISOString() }
      return HttpResponse.json({ approval: pending })
    }))
  renderPanel()
  expect((await screen.findByText('Installed fingerprint')).parentElement).toHaveTextContent(deviceApproval.fingerprintDigest)
  expect(screen.getByRole('heading', { name: deviceProfile.name })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Approve' }))
  expect(await screen.findByText('Approved for physical qualification')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})
it('does not offer approval for an expired fingerprint', async () => {
  handlers({ ...deviceApproval, expiresAt: '2020-01-01T00:00:00.000Z' }); renderPanel()
  expect(await screen.findByText('Expired — request a new fingerprint')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})
it('keeps the exact original command on denied retry and shows the real error', async () => {
  const base = handlers(), commands: string[] = [], user = userEvent.setup()
  server.use(http.post(`${base}/runtime-qualifications/${deviceApproval.id}/approve`, async ({ request }) => {
    commands.push((await request.json() as { commandId: string }).commandId)
    return HttpResponse.json({ error: { code: 'AUTH_DENIED', message: 'A verified human browser session is required.', requestId: 'denied' } }, { status: 403 })
  }))
  renderPanel(); await user.click(await screen.findByRole('button', { name: 'Approve' }))
  expect(await screen.findByText('A verified human browser session is required.')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(commands).toHaveLength(2)); expect(commands[1]).toBe(commands[0])
})
