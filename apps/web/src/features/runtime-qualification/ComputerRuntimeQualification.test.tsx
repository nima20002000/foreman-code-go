import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { JobRuntimeApprovalSchema, JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import { JobVerificationProfileSchema, JobVerificationRuntimeMeasurementSchema, type JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { server } from '../../mocks/server'
import { profile, approval, verificationProfile } from '../../test/jobRuntimeFixture'
import { verificationMeasurementFixture } from '../../../../../packages/contracts/tests/helpers/jobVerification'
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
  const rendered = render(<QueryClientProvider client={client}><ComputerRuntimeQualification registration={registration} /></QueryClientProvider>)
  return { client, ...rendered }
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
  const pending = JobVerificationProfileSchema.parse({ ...verificationProfile, root, approvalConfig: {
    ...verificationProfile.approvalConfig, review: { reviewedByPrincipalId: 'owner',
      reviewedAt: profile.createdAt, decisionDigest: 'a'.repeat(64) } } })
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: pending,
    ready: false, reasons: ['runtime_configuration_changed'], sideEffects: false }], approvals: [] })))
  renderPanel()
  expect(await screen.findByRole('heading', { name: pending.name })).toBeInTheDocument()
  expect(screen.getByText(/Verification needs runtime setup/)).toHaveTextContent('runtime setup for this saved commit')
  expect(screen.getByText(/Verification needs runtime setup/)).toHaveTextContent('offline dependencies and a 1-hour qualification lifetime')
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
  const pending = JobVerificationProfileSchema.parse({ ...verificationProfile, root, approvalConfig: {
    ...verificationProfile.approvalConfig, review: { reviewedByPrincipalId: 'owner',
      reviewedAt: profile.createdAt, decisionDigest: 'a'.repeat(64) } } })
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
  const prepare = await screen.findByRole('button', { name: 'Prepare automatically' })
  await waitFor(() => expect(prepare).toBeEnabled())
  await userEvent.click(prepare)
  expect(await screen.findByText(`Building the offline packages and image at ${commit.slice(0, 12)} — fetch-packages`)).toBeInTheDocument()
  expect(started).toEqual({ commandId: expect.any(String) })
  expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})


function preparationFixture() {
  const base = handlers()
  const pending = JobVerificationProfileSchema.parse({ ...verificationProfile, root, approvalConfig: {
    ...verificationProfile.approvalConfig, review: { reviewedByPrincipalId: 'owner',
      reviewedAt: profile.createdAt, decisionDigest: 'a'.repeat(64) } } })
  const url = `${base}/runtime-profiles/${pending.id}/computer-preparation`
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{ profile: pending,
    ready: false, reasons: ['runtime_configuration_changed'], sideEffects: false }], approvals: [] })))
  const status = { profileId: pending.id, deviceId, state: 'idle', commit: null, stage: null,
    message: null, profiles: [], startedAt: null, updatedAt: null }
  return { base, pending, url, status }
}

it('shows initial preparation loading and a failed read with a status-only retry', async () => {
  const f = preparationFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  let writes = 0
  server.use(http.get(f.url, async () => {
    reads++
    if (reads === 1) { await held; return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Worker offline' } }, { status: 503 }) }
    return HttpResponse.json(f.status)
  }), http.post(f.url, () => { writes++; return HttpResponse.json(f.status) }))
  renderPanel()
  expect(await screen.findByText('Loading preparation status…')).toBeInTheDocument()
  release()
  expect(await screen.findByText('Preparation status could not be read: Worker offline')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Retry preparation status' }))
  await waitFor(() => expect(screen.queryByText(/Preparation status could not be read/)).not.toBeInTheDocument())
  expect(reads).toBe(2)
  expect(writes).toBe(0)
})

it('recovers a failed progress poll without starting another preparation', async () => {
  const f = preparationFixture()
  let failing = false
  let writes = 0
  server.use(http.get(f.url, () => failing
    ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Main restarted' } }, { status: 503 })
    : HttpResponse.json({ ...f.status, state: 'preparing', stage: 'packages' })),
  http.post(f.url, () => { writes++; return HttpResponse.json(f.status) }))
  const panel = renderPanel()
  expect(await screen.findByRole('button', { name: 'Preparing…' })).toBeDisabled()
  failing = true
  await act(() => panel.client.refetchQueries({ queryKey: ['workbench', 'job-runtime-profiles', 'preparation'] }))
  expect(await screen.findByText('Preparation status could not be read: Main restarted')).toBeVisible()
  failing = false
  server.use(http.get(f.url, () => HttpResponse.json({ ...f.status, state: 'failed', message: 'Out of disk space' })))
  await userEvent.click(screen.getByRole('button', { name: 'Retry preparation status' }))
  expect(await screen.findByText('Preparation failed: Out of disk space')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Prepare automatically' })).toBeEnabled()
  expect(writes).toBe(0)
})

it.each([
  ['qualifying', 'Qualification in progress'],
  ['complete', 'Qualification complete'],
  ['failed', 'Qualification failed'],
  ['cancelled', 'Qualification cancelled'],
  ['recovery-required', 'Qualification needs recovery'],
] as const)('labels a %s candidate by its recorded state rather than capture expiry', async (status, label) => {
  handlers({ ...deviceCandidate, status, expiresAt: '2020-01-01T00:00:00.000Z' })
  renderPanel()
  expect(await screen.findByText(new RegExp(label))).toBeVisible()
  expect(screen.queryByText('Captured — ready to qualify')).not.toBeInTheDocument()
})

it('shows qualified profiles without candidates and gives a legacy next step', async () => {
  const base = handlers()
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{
    profile: { ...deviceProfile, status: 'qualified' }, ready: true, reasons: [], sideEffects: false,
  }], approvals: [] })))
  renderPanel()
  expect(await screen.findByRole('heading', { name: deviceProfile.name })).toBeVisible()
  expect(screen.getByText('Qualified — ready')).toBeVisible()
  expect(screen.getByText(/Ask Operator to capture this installed runtime profile/)).toBeVisible()
})

it('shows failed profiles without candidates and gives setup guidance for an empty computer', async () => {
  const base = handlers()
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{
    profile: { ...deviceProfile, status: 'failed' }, ready: false, reasons: ['runtime_unavailable'], sideEffects: false,
  }], approvals: [] })))
  const panel = renderPanel()
  expect(await screen.findByText('Qualification failed')).toBeVisible()
  expect(screen.getByText(/runtime_unavailable/)).toBeVisible()
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [], approvals: [] })))
  await act(() => panel.client.refetchQueries({ queryKey: ['workbench', 'job-runtime-profiles'] }))
  expect(await screen.findByText(/No runtime profiles for this computer/)).toBeVisible()
  expect(screen.getByText(/Ask Operator to create a verification profile/)).toBeVisible()
})


function qualifiedProfile(pending: JobVerificationProfile) {
  const original = verificationMeasurementFixture()
  const sourceCommit = 'c'.repeat(40)
  const checkedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  const fingerprint = { ...original.fingerprint, profileId: pending.id, profileRevision: pending.revision,
    specDigest: pending.specDigest, root, hostRef: host, registration: pins,
    sourceCommit, imageDigest: pending.spec.policy.imageDigest,
    imageConfigDigest: pending.spec.policy.imageDigest, imageManifestDigest: pending.spec.policy.imageDigest,
    toolchainDigest: pending.spec.policy.toolchainDigest, approvalConfig: pending.approvalConfig }
  const measurement = JobVerificationRuntimeMeasurementSchema.parse({ ...original, fingerprint,
    approvedAt: checkedAt, checkedAt, expiresAt,
    identity: { ...original.identity, profileId: pending.id, profileRevision: pending.revision,
      rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
      imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest,
      approvalExpiresAt: expiresAt, qualificationExpiresAt: expiresAt } })
  return JobVerificationProfileSchema.parse({ ...pending, sourceCommit, status: 'qualified', measurement,
    spec: { ...pending.spec, suites: ['unit'] } })
}

it('keeps automatic preparation available for an already-qualified reviewed verification profile', async () => {
  const f = preparationFixture()
  const qualified = qualifiedProfile(f.pending)
  let writes = 0
  server.use(http.get(`${f.base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{
    profile: qualified, ready: true, reasons: [], sideEffects: false,
  }], approvals: [] })),
  http.get(f.url, () => HttpResponse.json(f.status)),
  http.post(f.url, () => { writes++; return HttpResponse.json({ ...f.status, state: 'approving' }) }))
  renderPanel()
  expect(await screen.findByText('Qualified — ready')).toBeVisible()
  const prepare = await screen.findByRole('button', { name: 'Prepare automatically' })
  await waitFor(() => expect(prepare).toBeEnabled())
  await userEvent.click(prepare)
  expect(await screen.findByText('Approving the commit')).toBeVisible()
  expect(writes).toBe(1)
})

it('explains how to review a verification profile before automatic preparation is supported', async () => {
  const base = handlers()
  const unreviewed = JobVerificationProfileSchema.parse({ ...verificationProfile, root })
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{
    profile: unreviewed, ready: false, reasons: [], sideEffects: false,
  }], approvals: [] })))
  renderPanel()
  expect(await screen.findByText(/Ask Operator to save a reviewed verification profile/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Prepare automatically' })).not.toBeInTheDocument()
})


it.each([
  ['unqualified', 'Not qualified'],
  ['captured', 'Runtime captured'],
  ['awaiting-approval', 'Runtime captured'],
  ['qualifying', 'Qualification in progress'],
  ['qualified', 'Qualified — setup needs attention'],
  ['failed', 'Qualification failed'],
  ['revoked', 'Qualification revoked'],
  ['recovery-required', 'Qualification needs recovery'],
] as const)('shows a legacy profile in the %s state with a supported next step', async (status, label) => {
  const base = handlers()
  server.use(http.get(`${base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{
    profile: { ...deviceProfile, status }, ready: false, reasons: [], sideEffects: false,
  }], approvals: [] })))
  renderPanel()
  expect(await screen.findByText(label)).toBeVisible()
  if (status === 'recovery-required') {
    expect(screen.getByText(/Ask Operator to reconcile the original qualification/)).toBeVisible()
  } else if (status === 'qualifying') {
    expect(screen.getByText(/Refresh runtime qualification to follow the running qualification/)).toBeVisible()
  } else if (status === 'captured' || status === 'awaiting-approval') {
    expect(screen.getByText(/Ask Operator to run the captured qualification/)).toBeVisible()
  } else {
    expect(screen.getByText(/Ask Operator to capture this installed runtime profile/)).toBeVisible()
  }
  expect(screen.getByRole('button', { name: 'Refresh runtime qualification' })).toBeEnabled()
})


it('states the legacy build-profile limitation and local setup alternative', async () => {
  handlers()
  renderPanel()
  expect(await screen.findByText(/Automatic preparation is unavailable for legacy build profiles/)).toBeVisible()
  expect(screen.getByText(/Runtime installation and repair must be performed locally/)).toBeVisible()
  expect(screen.getByText(/Ask Operator to capture this installed runtime profile/)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Prepare automatically' })).not.toBeInTheDocument()
})


it('keeps the preparation success result visible when the saved profile becomes ready', async () => {
  const f = preparationFixture()
  const qualified = qualifiedProfile(f.pending)
  let ready = false
  const completed = { ...f.status, state: 'qualified', commit: qualified.sourceCommit,
    profiles: [{ profileId: qualified.id, revision: qualified.revision, status: qualified.status }] }
  server.use(
    http.get(`${f.base}/runtime-profiles`, () => HttpResponse.json({ profiles: [{
      profile: ready ? qualified : f.pending, ready, reasons: [], sideEffects: false,
    }], approvals: [] })),
    http.get(f.url, () => HttpResponse.json(completed)),
  )
  const panel = renderPanel()
  const success = `Qualified at ${qualified.sourceCommit!.slice(0, 12)}`
  expect(await screen.findByText(success)).toBeVisible()
  expect(screen.getByRole('heading', { name: f.pending.name })).toBeVisible()
  ready = true
  await act(() => panel.client.refetchQueries({ queryKey: ['workbench', 'job-runtime-profiles'] }))
  expect(await screen.findByText('Qualified — ready')).toBeVisible()
  expect(screen.getByText(success)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Prepare automatically' })).toBeEnabled()
})
