import { nativeAgentEnvironment } from '../harnesses/secrets.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import type pg from 'pg'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresSourceService } from '../sources/service.js'
import type { InstalledJobRuntimeHost } from './runtimeProfileFactory.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { createJobQualificationCarrier } from './qualificationCarrier.js'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobRuntimeNativeAdmissionSchema } from '@foreman-code/contracts/job-runtime'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import * as processes from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { JobQualificationCandidateSchema, jobQualificationFingerprint } from './qualification.js'
import { reserveInstalledJobQualification, runInstalledJobRuntimeQualification,
  reconcileInstalledJobRuntimeQualification } from './installedRuntimeQualification.js'
import * as installedHost from './installedRuntimeHost.js'
import { JobVerificationQualificationCandidateSchema, JobRuntimeNativeAdmissionRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { DeviceExecutionAdmissionFields } from '@foreman-code/contracts/device-resources'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { createVerificationProfile } from './verificationProfiles.js'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'

const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64)
const roots: string[] = [], journals: RemoteOperationJournal[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(journals.splice(0).map(value => value.close())); await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))) })
async function fixture() {
  const bootId = bootIdentity()
  const root = { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
    selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
      locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
      accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: id, authorizedByPrincipalId: id,
    registration: null, attestationId: id, attestationDigest: digest, boundAt: '2026-10-01T00:00:00Z' }
  const candidate = JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id,
    fingerprint: { schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest, hostRef: { kind: 'main', mainId: id },
      registration: null, mainInstallationId: id, bootId, root, runtimeExecutable: process.execPath, runtimeBinarySha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
      ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest, configurationDigest: digest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152, findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest,
    controllerEnvironment: nativeAgentEnvironment(process.execPath, '/approved/runtime',
      { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' }), sourceParent: '/approved/source',
    runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 600 })
  const admission = JobRuntimeNativeAdmissionSchema.parse({ schemaVersion: 1, kind: 'job-runtime-qualification', approvalId: id,
    qualificationId: id, operationId: id, workspaceId: id, profileId: id, profileRevision: 1, fingerprintDigest: jobQualificationFingerprint(candidate),
    leaseId: id, runCommandId: 'real-command', runPrincipalId: 'real-running-principal', approvedByPrincipalId: 'real-human',
    hostRef: candidate.fingerprint.hostRef, registration: null, mainInstallationId: id, bootId, connection: null,
    admittedAt: new Date().toISOString(), expiresAt: '2100-01-01T00:00:00Z' })
  const directory = await privateFixtureDirectory('ci-native-journal-'); roots.push(directory)
  const path = join(directory, 'journal.json'), journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true }); journals.push(journal)
  const registry = { scope: vi.fn((owner: string) => ({ root: '/actual-registry', owner })), reserveLaunch: vi.fn(() => ({ root: '/actual-registry', owner: `qualification:${id}:${id}`, launchId: randomUUID() })),
    closeRegistration: vi.fn(), abandonReservedLaunch: vi.fn(async () => true), closeOwner: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ revision: '1', launches: [] })) } as unknown as processes.NativeProcessRegistry
  const authority = { assertCurrent: vi.fn(), readApproval: vi.fn(async () => ({ status: 'approved' as const, fingerprint: admission.fingerprintDigest,
    expiresAt: admission.expiresAt })), reserve: vi.fn() }
  const host = { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: admission.mainInstallationId,
    bootId: admission.bootId, connection: admission.connection }
  const input = { admission, candidate, journal, registry, authority, host, assertAdmission: vi.fn(), signal: new AbortController().signal }
  return { ...input, input, path }
}


async function verificationReservationFixture() {
  const f = await fixture()
  f.candidate.fingerprint.root.binding.canonicalPath = dirname(f.path)
  const v = verificationRuntimeFixture()
  const now = new Date().toISOString()
  const profile = createVerificationProfile({ id, workspaceId: id, revision: 1, name: 'Verification replay',
    root: f.candidate.fingerprint.root, sourceCommit: v.measurement.fingerprint.sourceCommit!,
    spec: { rootId: id, bindingRevision: 1, resources: v.measurement.fingerprint.resources,
      policy: jobPolicyRequirementsRecord(v.spec.policy), suites: ['unit'],
      approvalConfig: { approvalLifetimeMs: 24 * 60 * 60 * 1000 } }, previous: null, now })
  const candidate = JobVerificationQualificationCandidateSchema.parse({ ...f.candidate,
    sourceParent: dirname(f.path), backingFile: null, backingBytes: null, volumeCapacityBytes: v.measurement.fingerprint.quota.volumeCapacityBytes,
    profile, approvedAt: now,
    fingerprint: { ...v.measurement.fingerprint, profileId: id, profileRevision: 1,
      specDigest: profile.specDigest, root: profile.root, hostRef: f.host.hostRef, registration: null,
      mainInstallationId: id, bootId: f.host.bootId, runtimeExecutable: process.execPath,
      runtimeBinarySha256: f.candidate.fingerprint.runtimeBinarySha256, resources: profile.spec.resources,
      approvalConfig: profile.approvalConfig } })
  const admission = JobRuntimeNativeAdmissionRecordSchema.parse({ ...f.admission, schemaVersion: 3,
    fingerprintDigest: jobQualificationFingerprint(candidate),
    ...Object.fromEntries(Object.keys(DeviceExecutionAdmissionFields).map(key => [key, Reflect.get(candidate.fingerprint, key)])),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
  f.authority.readApproval.mockResolvedValue({ status: 'approved', fingerprint: admission.fingerprintDigest,
    expiresAt: admission.expiresAt })
  const input = { ...f.input, candidate, admission }
  return { ...f, input, candidate, admission }
}

describe('actual qualification reservation seams with mocked native entry only', () => {
  it('reopens a closed verification diagnostic and returns its original result without another reservation', async () => {
    const f = await verificationReservationFixture()
    const { input, candidate } = f
    const reserved = await reserveInstalledJobQualification(input)
    expect(await reserved.native.close()).toBe(true)
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: ['original measured suite failure'] }
    await reserved.native.recordResult!(result)
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.path)
    journals.push(reopened)
    const replay = await reserveInstalledJobQualification({ ...input, journal: reopened })
    expect(replay.native.completedResult).toEqual(result)
    await expect(replay.native.reserveProcess(process.execPath, ['info'])).rejects.toThrow('cannot launch')
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    expect((await reopened.qualificationStatus(id))?.candidate).toEqual(candidate)
  })
  it('denied approval and host mismatch perform no entry or registry reservation', async () => {
    const f = await fixture(); f.authority.readApproval.mockResolvedValue(null as never)
    await expect(reserveInstalledJobQualification(f.input)).rejects.toThrow('approval changed')
    expect(await f.journal.qualificationStatus(id)).toBeNull(); expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    f.authority.readApproval.mockResolvedValue({ status: 'approved', fingerprint: f.admission.fingerprintDigest, expiresAt: f.admission.expiresAt })
    await expect(reserveInstalledJobQualification({ ...f.input, host: { ...f.host, bootId: id } })).rejects.toThrow('context changed')
    expect(await f.journal.qualificationStatus(id)).toBeNull()
  })
  it('reopened original entry rejects another launch instead of replacing uncertain work', async () => {
    const f = await fixture(); await reserveInstalledJobQualification(f.input)
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    const recovered = await reserveInstalledJobQualification({ ...f.input, journal: reopened })
    expect(recovered.native.recoveryRequired).toBe(true)
    await expect(recovered.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow('executable/argv')
    expect(await recovered.native.close()).toBe(true)
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it.each(['timeout', 'disconnect', 'expiry'] as const)('retains only original-container cleanup authority after %s', async reason => {
    const f = await fixture()
    const controller = new AbortController()
    const admitted = await reserveInstalledJobQualification({ ...f.input, signal: controller.signal })
    const containerId = 'b'.repeat(64)
    await admitted.ownership.reserveContainerIntent(`graphql-ci-qualification-${id}`, f.admission.fingerprintDigest)
    await admitted.ownership.bindContainer(`graphql-ci-qualification-${id}`, containerId)
    if (reason === 'timeout') controller.abort()
    if (reason === 'disconnect') f.input.assertAdmission.mockRejectedValue(new Error('channel closed'))
    if (reason === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.admission.expiresAt) + 1)
    await expect(admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow()
    const cleanup = await admitted.native.reserveCleanupProcess!(process.execPath,
      ['--remote=false', 'container', 'inspect', containerId])
    expect(cleanup).toBeTruthy()
    for (const argv of [['--remote=false', 'start', containerId], ['--remote=false', 'info'],
      ['--remote=false', 'stop', '--time', '1', 'c'.repeat(64)]]) {
      await expect(admitted.native.reserveCleanupProcess!(process.execPath, argv)).rejects.toThrow('Only original-container')
    }
    expect((await f.journal.qualificationStatus(id))?.phase).toBe('native_entry_attempted')
  })

  it('retains quota claims until positive closure and reclaims only the original owner after restart', async () => {
    const f = await verificationReservationFixture()
    const admitted = await reserveInstalledJobQualification(f.input)
    const slot = f.candidate.fingerprint.quotaPool!.slots[0]!
    const namespace = join(f.candidate.sourceParent, slot.namespace, id)
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    const path = join(f.candidate.sourceParent, `quota-${slot.namespace}.claim.json`)
    await writeFile(path, JSON.stringify({ kind: 'qualification', qualificationId: id, operationId: id }), { mode: 0o600 })
    const metadata = await stat(path)
    await admitted.native.recordQuotaClaim!({ path, namespace, device: metadata.dev, inode: metadata.ino })
    await expect(import('./installedRuntimeQualification.js').then(module => module.releaseQualificationQuotaClaims(f.journal, id)))
      .rejects.toThrow('Positive qualification closure')
    expect((await f.journal.qualificationStatus(id))?.quotaClaims)
      .toEqual([{ path, namespace, device: metadata.dev, inode: metadata.ino }])
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.path)
    journals.push(reopened)
    const recovered = await reserveInstalledJobQualification({ ...f.input, journal: reopened, entry: 'reconcile',
      signal: AbortSignal.abort(new Error('original caller disconnected')) })
    await expect(recovered.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow()
    expect(await recovered.native.close()).toBe(true)
    expect((await reopened.qualificationStatus(id))?.quotaClaims)
      .toEqual([{ path, namespace, device: metadata.dev, inode: metadata.ino }])
    expect(await reconcileInstalledJobRuntimeQualification({ ...f.input, journal: reopened,
      signal: AbortSignal.abort(new Error('original caller disconnected')) }))
      .toMatchObject({ outcome: 'denied', closure: 'confirmed' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(namespace)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await reopened.qualificationStatus(id))?.quotaClaims).toEqual([])
  })

  it('reconciles qualification longer than the channel maximum through bounded start and status calls', async () => {
    const f = await verificationReservationFixture()
    const deviceId = randomUUID()
    const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
    const hostRef = { kind: 'device' as const, mainId: id, deviceId }
    const binding = { mainId: id, deviceId, ...registration, bootId: f.host.bootId,
      connectionGeneration: 1, connectionEpoch: randomUUID() }
    const root = structuredClone(f.candidate.fingerprint.root)
    root.selection.hostRef = hostRef
    root.registration = registration
    root.binding.deviceId = deviceId
    root.binding.workerInstallationId = registration.workerInstallationId
    const candidate = JobVerificationQualificationCandidateSchema.parse({ ...f.candidate,
      profile: { ...f.candidate.profile, root },
      fingerprint: { ...f.candidate.fingerprint, root, hostRef, registration } })
    const admission = JobRuntimeNativeAdmissionRecordSchema.parse({ ...f.admission, hostRef, registration,
      connection: binding, fingerprintDigest: jobQualificationFingerprint(candidate) })
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: ['measured suite failed'] }
    const request = vi.fn(async (payload: unknown, options: { timeoutMs?: number }) => {
      expect(options.timeoutMs).toBe(30000)
      const operation = (payload as { operation: string }).operation
      const missing = request.mock.calls.length === 1
      const complete = operation === 'status' && !missing
      if (operation === 'start') now += 16 * 60 * 1000
      let phase = 'running'
      if (missing) phase = 'not_started'
      if (complete) phase = 'complete'
      return { payload: { version: 3, operation, admission, candidate, phase, result: complete ? result : null } }
    })
    const endpoint = { currentBinding: () => binding, captureRequest: () => ({ binding, request }) } as unknown as DeviceEndpoint
    const carrier = createJobQualificationCarrier({ pool: {} as pg.Pool, sources: {} as PostgresSourceService,
      endpoint: () => endpoint, local: {} as InstalledJobRuntimeHost,
      workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }) })
    const assertAdmission = vi.fn(async () => undefined)
    expect(await carrier.host.runAdmitted!({ profile: candidate.profile, candidate, nativeAdmission: admission,
      assertAdmission, signal: new AbortController().signal, approval: {} as never, descriptor: {} as never })).toEqual(result)
    expect(request.mock.calls.map(([payload]) => (payload as { operation: string }).operation)).toEqual(['status', 'start', 'status'])
    expect(request.mock.calls.every(([payload]) =>
      (payload as { admission: { expiresAt: string } }).admission.expiresAt === admission.expiresAt)).toBe(true)
    expect(assertAdmission).toHaveBeenCalledTimes(2)
  })

  it('Main admission denial never reserves native entry and is rechecked before later commands', async () => {
    const f = await fixture()
    f.input.assertAdmission.mockRejectedValueOnce(new Error('revoked original authority'))
    await expect(reserveInstalledJobQualification(f.input)).rejects.toThrow('revoked original authority')
    expect(await f.journal.qualificationStatus(id)).toBeNull()
    const admitted = await reserveInstalledJobQualification(f.input)
    f.input.assertAdmission.mockRejectedValueOnce(new Error('revoked original authority'))
    await expect(admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])).rejects.toThrow('revoked original authority')
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('persists registry reservation before mocked spawn and refuses command/env substitution', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    const spawn = vi.spyOn(processes, 'spawnNativeProcess').mockImplementation(() => { throw new Error('must not launch') })
    const reservation = await admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])
    expect((await f.journal.qualificationStatus(id))?.launches[0]).toMatchObject({ launchId: reservation, binary: process.execPath, argv: ['--remote=false', 'info'] })
    expect(() => admitted.native.spawnProcess(reservation, process.execPath, ['--remote=false', 'start'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })).toThrow('entry changed')
    expect(() => admitted.native.spawnProcess(reservation, process.execPath, ['--remote=false', 'info'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...f.candidate.controllerEnvironment, SECRET: 'forbidden' } })).toThrow('entry changed')
    expect(spawn).not.toHaveBeenCalled()
    expect(await admitted.native.close()).toBe(true)
    expect(f.registry.abandonReservedLaunch).toHaveBeenCalled()
  })
  it('prepares the reserved executable PATH without changing the reviewed controller environment', async () => {
    const f = await fixture()
    f.candidate.controllerEnvironment.PATH = '/approved/helpers:/usr/bin:/bin'
    const originalEnvironment = { ...f.candidate.controllerEnvironment }
    const admitted = await reserveInstalledJobQualification(f.input)
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } }) as unknown as
      ReturnType<typeof processes.spawnNativeProcess>
    const spawn = vi.spyOn(processes, 'spawnNativeProcess').mockReturnValue(child)
    const argv = ['--remote=false', 'info']
    const reservation = await admitted.native.reserveProcess(process.execPath, argv)
    admitted.native.spawnProcess(reservation, process.execPath, argv, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: originalEnvironment,
    })
    expect(spawn).toHaveBeenCalledWith(process.execPath, argv, expect.objectContaining({
      env: nativeAgentEnvironment(process.execPath, f.candidate.runtimeRoot, originalEnvironment),
    }))
    expect(f.candidate.controllerEnvironment).toEqual(originalEnvironment)
    expect(() => admitted.native.spawnProcess(reservation, process.execPath, argv, {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...originalEnvironment, SECRET: 'forbidden' },
    })).toThrow('entry changed')
  })
  it('wrapper zero alone cannot become confirmed native success', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } }) as unknown as ReturnType<typeof processes.spawnNativeProcess>
    vi.spyOn(processes, 'spawnNativeProcess').mockReturnValue(child)
    const exit = vi.spyOn(processes, 'nativeProcessExit').mockReturnValue({ exitCode: null, exitSignal: null })
    const reservation = await admitted.native.reserveProcess(process.execPath, ['--remote=false', 'info'])
    admitted.native.spawnProcess(reservation, process.execPath, ['--remote=false', 'info'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })
    expect(await admitted.native.readNativeExit(reservation, child, { exitCode: 0, signal: null })).toEqual({ confirmed: false, exitCode: null })
    exit.mockReturnValue({ exitCode: 0, exitSignal: null })
    expect(await admitted.native.readNativeExit(reservation, child, { exitCode: 1, signal: null })).toEqual({ confirmed: true, exitCode: 0 })
    expect(f.registry.closeRegistration).toHaveBeenCalled()
    await expect(admitted.native.readNativeExit(reservation, new EventEmitter() as ChildProcess, { exitCode: 0, signal: null })).rejects.toThrow('target changed')
  })
  it('container identity/certificate and positive closure persist on the same journal', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input), ownership = admitted.ownership
    const identity = `graphql-ci-qualification-${id}`, containerId = 'b'.repeat(64)
    await ownership.reserveContainerIntent(identity, f.admission.fingerprintDigest)
    await ownership.bindContainer(identity, containerId)
    await expect(ownership.bindContainer(identity, 'c'.repeat(64))).rejects.toThrow('identity changed')
    const scope = ownership.scope
    expect('owner' in scope).toBe(false)
    const certificate = { scope, containerId, process: { pid: 42, startTicks: '123', bootId: f.admission.bootId },
      boundary: { kind: 'cgroup-v2' as const, path: `/sys/fs/cgroup/libpod-${containerId}.scope`, device: '1', inode: '2' }, helpers: [], lifecycle: 'active' as const }
    await ownership.publish(certificate)
    await expect(admitted.native.close()).rejects.toThrow('closure unconfirmed')
    await ownership.publish({ ...certificate, lifecycle: 'closed' })
    expect(await admitted.native.close()).toBe(true)
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    expect((await reopened.qualificationStatus(id))?.container?.certificate?.lifecycle).toBe('closed')
    await expect(reopened.qualificationCertificate(id, { ...certificate, lifecycle: 'active' })).rejects.toThrow('identity changed')
  })
  it('lost result acknowledgment replays persisted original diagnostic result after reopening without native entry', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    await admitted.native.close()
    const result = { outcome: 'denied' as const, closure: 'confirmed' as const, reasons: ['original diagnostic failed'] }
    await f.journal.qualificationResult(id, result)
    await expect(f.journal.qualificationResult(id, { ...result, reasons: ['replacement result'] })).rejects.toThrow('result changed')
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    vi.spyOn(installedHost, 'inspectInstalledJobRuntimeCandidate').mockResolvedValue()
    expect(await runInstalledJobRuntimeQualification({ ...f.input, configuration: null, journal: reopened })).toEqual(result)
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
    await expect(reopened.qualificationAccept(f.admission, { ...f.candidate, ttlSeconds: 1 })).rejects.toThrow('admission conflict')
  })
})
