import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { JobRuntimeApprovalSchema, JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { server } from '../../mocks/server'
import { profile, approval, verificationProfile } from '../../test/jobRuntimeFixture'
import { ComputerRuntimeQualification } from './ComputerRuntimeQualification'

const deviceId = '22222222-2222-4222-8222-222222222222', mainId = '11111111-1111-4111-8111-111111111111'
const registration: DeviceRegistration = { mainId, deviceId, workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1,
  publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
const host = { kind: 'device' as const, mainId, deviceId }, pins = { workerInstallationId: deviceId, keyRevision: 1, authorizationRevision: 1 }
const root = { ...profile.root, selection: { ...profile.root.selection, hostRef: host }, registration: pins,
  binding: { ...profile.root.binding, deviceId, workerInstallationId: deviceId } }
const deviceProfile = JobRuntimeProfileSchema.parse({ ...profile, root })
const deviceCandidate = JobRuntimeApprovalSchema.parse({ ...approval, fingerprint: { ...approval.fingerprint, root, hostRef: host, registration: pins } })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><ComputerRuntimeQualification registration={registration} /></QueryClientProvider>)
}
function handlers(pending = deviceCandidate) {
  const base = `/api/management/workspaces/${profile.workspaceId}/jobs`
  server.use(http.get('/api/management/workspaces', () => HttpResponse.json({ items: [{ workspace: { id: profile.workspaceId, name: 'Acceptance workspace', agentIds: [], workflowIds: [], createdAt: profile.createdAt, updatedAt: profile.updatedAt },
    revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } }], pageInfo: { nextCursor: null } })),
  http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: deviceProfile, ready: false, reasons: [], sideEffects: false }], approvals: [pending] })))
  return base
}
it('shows verification runtime setup without implying qualification', async () => {
  const base = handlers()
  const pending = JobVerificationProfileSchema.parse({ ...verificationProfile, root })
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: pending,
    ready: false, reasons: ['runtime_configuration_changed'], sideEffects: false }], approvals: [] })))
  renderPanel()
  expect(await screen.findByRole('heading', { name: pending.name })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('runtime setup for this saved commit')
  expect(screen.getByRole('status')).toHaveTextContent('offline dependencies and a 24-hour qualification lifetime')
  expect(screen.getByText('install, unit')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})
it('shows a paired computer captured fingerprint as ready to qualify, with no approval action', async () => {
  handlers(); renderPanel()
  expect((await screen.findByText('Installed fingerprint')).parentElement).toHaveTextContent(deviceCandidate.fingerprintDigest)
  expect(screen.getByRole('heading', { name: deviceProfile.name })).toBeInTheDocument()
  expect(screen.getByText('Captured — ready to qualify')).toBeInTheDocument()
  expect(screen.getByText(/No approval is needed/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})
it('asks for a new capture when the fingerprint expired', async () => {
  handlers({ ...deviceCandidate, expiresAt: '2020-01-01T00:00:00.000Z' }); renderPanel()
  expect(await screen.findByText('Expired — capture the installed runtime again')).toBeInTheDocument()
})
it('prepares the computer automatically and follows its stages', async () => {
  const base = handlers()
  const pending = JobVerificationProfileSchema.parse({ ...verificationProfile, root })
  const commit = 'c'.repeat(40)
  let started: unknown
  const status = (state: string, stage: string | null) => ({ profileId: pending.id, deviceId, state, commit, stage, message: null,
    profiles: [], startedAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' })
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: pending,
    ready: false, reasons: ['dependencies_changed'], sideEffects: false }], approvals: [] })),
  http.post(`${base}/runtime-profiles/${pending.id}/computer-preparation`, async ({ request }) => {
    started = await request.json(); return HttpResponse.json(status('preparing', 'fetch-packages'))
  }),
  http.get(`${base}/runtime-profiles/${pending.id}/computer-preparation`, () => HttpResponse.json(started
    ? status('preparing', 'fetch-packages') : { ...status('idle', null), commit: null, startedAt: null, updatedAt: null })))
  renderPanel()
  await userEvent.click(await screen.findByRole('button', { name: 'Prepare automatically' }))
  expect(await screen.findByText(`Building the offline packages and image at ${commit.slice(0, 12)} — fetch-packages`)).toBeInTheDocument()
  expect(started).toEqual({ commandId: expect.any(String) })
  expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})
