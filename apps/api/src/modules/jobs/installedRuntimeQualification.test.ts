import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobRuntimeNativeAdmissionSchema } from '@graphql/contracts/job-runtime'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import * as processes from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { JobQualificationCandidateSchema, jobQualificationFingerprint } from './qualification.js'
import { reserveInstalledJobQualification, runInstalledJobRuntimeQualification } from './installedRuntimeQualification.js'
import * as installedHost from './installedRuntimeHost.js'

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
      registration: null, mainInstallationId: id, bootId, root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest,
      ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest, configurationDigest: digest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152, findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest,
    controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' }, sourceParent: '/approved/source',
    runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 600 })
  const admission = JobRuntimeNativeAdmissionSchema.parse({ schemaVersion: 1, kind: 'job-runtime-qualification', approvalId: id,
    qualificationId: id, operationId: id, workspaceId: id, profileId: id, profileRevision: 1, fingerprintDigest: jobQualificationFingerprint(candidate),
    leaseId: id, runCommandId: 'real-command', runPrincipalId: 'real-running-principal', approvedByPrincipalId: 'real-human',
    hostRef: candidate.fingerprint.hostRef, registration: null, mainInstallationId: id, bootId, connection: null,
    admittedAt: new Date().toISOString(), expiresAt: '2100-01-01T00:00:00Z' })
  const directory = await mkdtemp(join(tmpdir(), 'ci-native-journal-')); roots.push(directory)
  const path = join(directory, 'journal.json'), journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true }); journals.push(journal)
  const registry = { reserveLaunch: vi.fn(() => ({ root: '/actual-registry', owner: `qualification:${id}:${id}`, launchId: id })),
    closeRegistration: vi.fn(), abandonReservedLaunch: vi.fn(async () => true), closeOwner: vi.fn(async () => true),
    snapshot: vi.fn(() => ({ revision: '1', launches: [] })) } as unknown as processes.NativeProcessRegistry
  const authority = { assertCurrent: vi.fn(), readApproval: vi.fn(async () => ({ status: 'approved' as const, fingerprint: admission.fingerprintDigest,
    expiresAt: admission.expiresAt })), reserve: vi.fn() }
  const host = { hostRef: admission.hostRef, registration: admission.registration, mainInstallationId: admission.mainInstallationId,
    bootId: admission.bootId, connection: admission.connection }
  const input = { admission, candidate, journal, registry, authority, host, assertAdmission: vi.fn(), signal: new AbortController().signal }
  return { ...input, input, path }
}

describe('actual qualification reservation seams with mocked native entry only', () => {
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
    await expect(reserveInstalledJobQualification({ ...f.input, journal: reopened })).rejects.toThrow('without rerunning')
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('Main admission denial never reserves native entry and is rechecked before later commands', async () => {
    const f = await fixture()
    f.input.assertAdmission.mockRejectedValueOnce(new Error('revoked original authority'))
    await expect(reserveInstalledJobQualification(f.input)).rejects.toThrow('revoked original authority')
    expect(await f.journal.qualificationStatus(id)).toBeNull()
    const admitted = await reserveInstalledJobQualification(f.input)
    f.input.assertAdmission.mockRejectedValueOnce(new Error('revoked original authority'))
    await expect(admitted.native.reserveProcess('/usr/bin/podman', ['--remote=false', 'info'])).rejects.toThrow('revoked original authority')
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  })
  it('persists registry reservation before mocked spawn and refuses command/env substitution', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    const spawn = vi.spyOn(processes, 'spawnNativeProcess').mockImplementation(() => { throw new Error('must not launch') })
    const reservation = await admitted.native.reserveProcess('/usr/bin/podman', ['--remote=false', 'info'])
    expect((await f.journal.qualificationStatus(id))?.launches[0]).toMatchObject({ launchId: reservation, binary: '/usr/bin/podman', argv: ['--remote=false', 'info'] })
    expect(() => admitted.native.spawnProcess(reservation, '/usr/bin/podman', ['--remote=false', 'start'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })).toThrow('entry changed')
    expect(() => admitted.native.spawnProcess(reservation, '/usr/bin/podman', ['--remote=false', 'info'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...f.candidate.controllerEnvironment, SECRET: 'forbidden' } })).toThrow('entry changed')
    expect(spawn).not.toHaveBeenCalled()
    expect(await admitted.native.close()).toBe(true)
    expect(f.registry.abandonReservedLaunch).toHaveBeenCalled()
  })
  it('wrapper zero alone cannot become confirmed native success', async () => {
    const f = await fixture(), admitted = await reserveInstalledJobQualification(f.input)
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } }) as unknown as ReturnType<typeof processes.spawnNativeProcess>
    vi.spyOn(processes, 'spawnNativeProcess').mockReturnValue(child)
    const exit = vi.spyOn(processes, 'nativeProcessExit').mockReturnValue({ exitCode: null, exitSignal: null })
    const reservation = await admitted.native.reserveProcess('/usr/bin/podman', ['--remote=false', 'info'])
    admitted.native.spawnProcess(reservation, '/usr/bin/podman', ['--remote=false', 'info'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.candidate.controllerEnvironment })
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
