import type { JobExecution } from '@graphql/contracts/jobs'
import { JOB_PRIVATE_GIT_LAYOUT, type VerifiedJobGitMounts } from './privateGitMounts.js'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { constants, readFileSync as requireRead } from 'node:fs'
import { identity } from '../sources/privateFilesystem.js'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { jobSpecDigests } from '@graphql/contracts/jobs-node'
import type { RemoteJobDispatchIntent } from '@graphql/contracts/remote-job-execution'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { jobSupervisorIdentity } from './executor.js'
import { createInstalledJobExecutionHost } from './executorInstalled.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
const roots: string[] = [], journals: RemoteOperationJournal[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(journals.splice(0).map(value => value.close())); await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ci-job-owner-')); roots.push(root)
  const path = join(root, 'job-runtime-operations.json'), journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true }); journals.push(journal)
  const execution = jobExecution(); execution.acceptedSpec.target.mainInstallationId = execution.acceptedSpec.target.mainId
  const sourceRoot = join(root, execution.acceptedSpec.source.materializationId,'tree'), runtimeRoot = join(root, 'runtime'); await mkdir(dirname(sourceRoot),{mode:0o700});await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(runtimeRoot, { mode: 0o700 })
  const handle = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY), filesystem = await identity(handle); await handle.close()
  Object.assign(execution.acceptedSpec.target.destination, { canonicalProjectRoot: sourceRoot, canonicalCwd: sourceRoot, managedRuntimeRoot: runtimeRoot, directoryIdentityHash: createHash('sha256').update(JSON.stringify(filesystem)).digest('hex') })
  Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, null))
  const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: execution.acceptedSpec.target.mainId,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash,
    inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner }
  const connection = { kind: 'main' as const, mainId: intent.mainId, mainInstallationId: execution.acceptedSpec.target.mainInstallationId, bootId: bootIdentity() }
  await journal.jobAccept(intent, execution, connection, randomUUID())
  const certificate = { scope: { subject: { kind: 'job' as const, executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: intent.bindingHash },
    leaseId: execution.operationId, owner: execution.owner, observedDeviceId: null, observedInstallationId: connection.mainInstallationId, bootId: connection.bootId },
    containerId: 'a'.repeat(64), process: { pid: 42, startTicks: '123', bootId: connection.bootId },
    boundary: { kind: 'cgroup-v2' as const, path: `/sys/fs/cgroup/libpod-${'a'.repeat(64)}.scope`, device: '1', inode: '2' }, helpers: [], lifecycle: 'active' as const }
  return { root, path, journal, execution, intent, connection, certificate }
}
describe('original Job native journal, no live isolation claim', () => {
  it('requires the admitted entry before launcher/container reservations', async () => {
    const f = await fixture()
    await expect(f.journal.jobContainerIntent(f.execution.operationId, jobSupervisorIdentity(f.execution), f.execution.acceptedSpec.specDigest)).rejects.toThrow('reservation required')
    expect(await f.journal.jobNativeOwner(f.execution.operationId)).toBeNull()
  })
  it('retains exact process/container/deadline and timeout across reopening the original journal', async () => {
    const f = await fixture(), id = randomUUID(); await f.journal.jobReserveEntry(f.execution.operationId)
    await f.journal.jobReserveProcess(f.execution.operationId, { launchId: id, binary: '/usr/bin/podman', argv: ['--remote=false', 'create'] })
    await f.journal.jobContainerIntent(f.execution.operationId, jobSupervisorIdentity(f.execution), f.execution.acceptedSpec.specDigest)
    await f.journal.jobBindContainer(f.execution.operationId, jobSupervisorIdentity(f.execution), f.certificate.containerId)
    await f.journal.jobCertificate(f.execution.operationId, f.certificate)
    const deadline = (await f.journal.jobNativeOwner(f.execution.operationId))?.container?.deadlineAt
    await f.journal.jobBindContainer(f.execution.operationId, jobSupervisorIdentity(f.execution), f.certificate.containerId)
    expect((await f.journal.jobNativeOwner(f.execution.operationId))?.container?.deadlineAt).toBe(deadline)
    await f.journal.jobProcessClosed(f.execution.operationId, id, { exitCode: 7, signal: null }); await f.journal.jobTimedOut(f.execution.operationId)
    await f.journal.jobCertificate(f.execution.operationId, { ...f.certificate, lifecycle: 'closed' })
    await f.journal.close(); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    expect(await reopened.jobNativeOwner(f.execution.operationId)).toMatchObject({ timedOut: true, launches: [{ launchId: id, exit: { exitCode: 7 }, closed: true }], container: { deadlineAt: deadline, certificate: { lifecycle: 'closed' } } })
    await expect(reopened.jobCertificate(f.execution.operationId, f.certificate)).rejects.toThrow('cannot reopen')
    expect((await reopened.jobReserveEntry(f.execution.operationId)).reserved).toBe(false)
  })
  it('rejects changed container ID, boundary, grant and host rather than borrowing diagnostic authority', async () => {
    const f = await fixture(); await f.journal.jobReserveEntry(f.execution.operationId)
    await f.journal.jobContainerIntent(f.execution.operationId, jobSupervisorIdentity(f.execution), f.execution.acceptedSpec.specDigest)
    await f.journal.jobBindContainer(f.execution.operationId, jobSupervisorIdentity(f.execution), f.certificate.containerId)
    await f.journal.jobCertificate(f.execution.operationId, f.certificate)
    await expect(f.journal.jobBindContainer(f.execution.operationId, jobSupervisorIdentity(f.execution), 'b'.repeat(64))).rejects.toThrow('conflict')
    await expect(f.journal.jobCertificate(f.execution.operationId, { ...f.certificate, scope: { ...f.certificate.scope, owner: { grantId: 'other', epoch: '1' } } })).rejects.toThrow('scope changed')
    await expect(f.journal.jobCertificate(f.execution.operationId, { ...f.certificate, boundary: { ...f.certificate.boundary, inode: '99' } })).rejects.toThrow('boundary changed')
    await expect(f.journal.jobCertificate(f.execution.operationId, { ...f.certificate, scope: { ...f.certificate.scope, observedDeviceId: 'invented-device' } })).rejects.toThrow('scope changed')
  })
  it('reads old journals with absent additive Job owner records; never initializes missing original identity', async () => {
    const f = await fixture(); await f.journal.close()
    const old = JSON.parse(await readFile(f.path, 'utf8')); delete old.jobOwners; await writeFile(f.path, JSON.stringify(old))
    const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    expect(await reopened.jobStatus(f.execution.operationId)).toMatchObject({ status: 'known', receipt: { intent: f.intent } })
    expect(await reopened.jobNativeOwner(f.execution.operationId)).toBeNull()
    await expect(RemoteOperationJournal.open(join(f.root, 'missing-original.json'))).rejects.toThrow('recovery required')
  })
  it('installed factory rejects executable-only readiness before source/input or guarded native entry', async () => {
    const f = await fixture(), reserveLaunch = vi.fn(), source = vi.fn(), prepare = vi.fn(), observeReceipt = vi.fn()
    const host = createInstalledJobExecutionHost({ journal: f.journal, connection: f.connection, incarnationId: randomUUID(), configuration: null,
      registry: { reserveLaunch } as unknown as NativeProcessRegistry, source: { verify: source }, inputs: { prepare }, authorize: vi.fn(),
      observeReceipt, appendLog: vi.fn(), collectOutputs: vi.fn() })
    await host.deliver(f.intent, f.execution); await host.drain()
    expect(reserveLaunch).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled()
    expect(await f.journal.jobStatus(f.execution.operationId)).toMatchObject({ status: 'known', receipt: { entryAttempted: false, terminal: { outcome: 'preparation_failed', processStopped: true }, publication: 'complete' } })
    expect(observeReceipt).toHaveBeenCalled()
  })
})

// Complete measured shape modeled in unit tests; no actual qualification claim.
async function qualifiedFixture() {
  const f = await fixture(), id = randomUUID(), digest = 'd'.repeat(64), bootId = f.connection.bootId
  const parent = await open(f.root, constants.O_RDONLY | constants.O_DIRECTORY), filesystem = await identity(parent); await parent.close()
  const root = { version: 1 as const, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
    selection: { hostRef: f.execution.acceptedSpec.target.hostRef, rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1 as const, mainId: f.intent.mainId, deviceId: null, workerInstallationId: null, workspaceId: f.execution.workspaceId, rootId: id, bindingRevision: 1,
      locationRevision: 1, canonicalPath: f.root, filesystem, accessMode: 'exclusive-write' as const, snapshotId: id, manifestDigest: digest },
    ownerPrincipalId: id, authorizedByPrincipalId: id, registration: null, attestationId: id, attestationDigest: digest, boundAt: new Date().toISOString() }
  const candidate = { qualificationId: id, operationId: id, approvalId: id,
    fingerprint: {workspaceLayout:JOB_PRIVATE_GIT_LAYOUT,schemaVersion: 1 as const, profileId: f.execution.acceptedSpec.policy.isolationPolicyId, profileRevision: 1, specDigest: digest,
      hostRef: f.execution.acceptedSpec.target.hostRef, registration: null, mainInstallationId: f.connection.mainInstallationId, bootId, root,
      runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, configurationDigest: digest,
      imageDigest: f.execution.acceptedSpec.policy.imageDigest, toolchainDigest: f.execution.acceptedSpec.policy.toolchainDigest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152, findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest,
    controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' as const }, sourceParent: f.root,
    runtimeRoot: f.execution.acceptedSpec.target.destination.managedRuntimeRoot, spoolBytes: 131072, ttlSeconds: 600 }
  const { jobQualificationFingerprint } = await import('./qualification.js')
  const fingerprintDigest = jobQualificationFingerprint(candidate)
  const admission = { schemaVersion: 1 as const, kind: 'job-runtime-qualification' as const, approvalId: id, qualificationId: id, operationId: id,
    workspaceId: f.execution.workspaceId, profileId: candidate.fingerprint.profileId, profileRevision: 1, fingerprintDigest, leaseId: id,
    runCommandId: 'qualification-command', runPrincipalId: 'qualification-principal', approvedByPrincipalId: 'human',
    hostRef: candidate.fingerprint.hostRef, registration: null, mainInstallationId: f.connection.mainInstallationId, bootId, connection: null,
    admittedAt: new Date().toISOString(), expiresAt: '2100-01-01T00:00:00Z' }
  const runtime = { ...candidate.fingerprint.limits, policyId: candidate.fingerprint.profileId, policyRevision: 1,
    workspaceLayout:JOB_PRIVATE_GIT_LAYOUT,imageDigest: candidate.fingerprint.imageDigest, toolchainDigest: candidate.fingerprint.toolchainDigest, runtimeVersion: 'unit-double',
    ociRuntimeVersion: 'unit-double', kernelVersion: 'unit-double', qualificationId: id, rootless: true as const, cgroupV2: true as const,
    filesystemBounded: true as const, descendantContainment: true as const, network: 'none' as const }
  const measurement = { schemaVersion: 1 as const, qualificationId: id, profileId: runtime.policyId, profileRevision: 1, specDigest: digest,
    hostRef: candidate.fingerprint.hostRef, registration: null, root, runtime, runtimeBinarySha256: digest, ociBinarySha256: digest,
    runtimeExecutable: candidate.fingerprint.runtimeExecutable, environment: candidate.controllerEnvironment, fingerprint: candidate.fingerprint,
    fingerprintDigest, approvalId: id, origin: 'real-runtime' as const, checkedAt: new Date().toISOString(), expiresAt: '2100-01-01T00:00:00Z',
    checks: (['rootless', 'cgroup-v2', 'filesystem-quota', 'descendant-containment', 'network-none', 'image-toolchain', 'credential-isolation'] as const).map(id => ({ id, passed: true, evidenceDigest: digest })) }
  await f.journal.qualificationAccept(admission, candidate); await f.journal.qualificationReserveEntry(id)
  const containerId = 'b'.repeat(64), containerIdentity = `graphql-ci-qualification-${id}`
  await f.journal.qualificationContainerIntent(id, containerIdentity, fingerprintDigest); await f.journal.qualificationBindContainer(id, containerIdentity, containerId)
  await f.journal.qualificationCertificate(id, { scope: { subject: { kind: 'qualification', qualificationId: id, profileId: runtime.policyId, profileRevision: 1, operationId: id, fingerprint: fingerprintDigest }, admission, bootId },
    containerId, process: { pid: 42, startTicks: '123', bootId }, boundary: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/libpod-${containerId}.scope`, device: '1', inode: '2' }, helpers: [], lifecycle: 'closed' })
  await f.journal.qualificationClose(id)
  await f.journal.qualificationResult(id, { outcome: 'qualified', measurement })
  return { ...f, candidate, measurement }
}
describe('measured qualifier selection remains distinct from a Job grant', () => {
  it('selects only original matching measured policy/host/root evidence', async () => {
    const f = await qualifiedFixture()
    expect((await f.journal.qualifiedJobRuntime(f.execution)).candidate).toEqual(f.candidate)
    const changed = structuredClone(f.execution); changed.acceptedSpec.target.destination.rootPolicyRevision = '2'
    await expect(f.journal.qualifiedJobRuntime(changed)).rejects.toThrow('missing or ambiguous')
    changed.acceptedSpec.target.destination.rootPolicyRevision = '1'; changed.acceptedSpec.policy.toolchainDigest = 'a'.repeat(64)
    await expect(f.journal.qualifiedJobRuntime(changed)).rejects.toThrow('missing or ambiguous')
    expect(await f.journal.jobNativeOwner(f.execution.operationId)).toBeNull()
  })
  it('pins the original qualifier for cleanup without granting expired evidence a fresh launch', async () => {
    const f = await qualifiedFixture(); await f.journal.jobReserveEntry(f.execution.operationId)
    await f.journal.jobContainerIntent(f.execution.operationId, jobSupervisorIdentity(f.execution), f.execution.acceptedSpec.specDigest, f.candidate.operationId)
    await f.journal.close()
    const data = JSON.parse(await readFile(f.path, 'utf8')); data.qualificationReceipts[0].result.measurement.expiresAt = '2026-10-01T00:00:00.000Z'
    data.qualificationReceipts[0].result.measurement.checkedAt = '2026-09-30T00:00:00.000Z'
    await writeFile(f.path, JSON.stringify(data)); const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    expect((await reopened.qualifiedJobRuntime(f.execution)).candidate.operationId).toBe(f.candidate.operationId)
    const fresh = structuredClone(f.execution); fresh.operationId = 'different-job-operation'
    await expect(reopened.qualifiedJobRuntime(fresh)).rejects.toThrow('missing or ambiguous')
    expect((await reopened.jobReserveEntry(f.execution.operationId)).reserved).toBe(false)
  })
})

describe('installed actual Job factory with native/process doubles', () => {
  it('journals guarded commands before spawn and keeps observed exit7 separate from publication transport', async () => {
    const f = await qualifiedFixture()
    const { EventEmitter } = await import('node:events'), { PassThrough } = await import('node:stream')
    const processes = await import('../harnesses/recovery/processRegistry.js')
    const installed = await import('./installedRuntimeHost.js'), qualification = await import('./qualification.js')
    const { OwnedOCIContainer } = await import('./executorContainerOwner.js')
    const { JOB_INPUT_DIRECTORY } = await import('@graphql/contracts/job-inputs')
    const { jobInputSnapshotDigest } = await import('@graphql/contracts/job-inputs-node')
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    vi.spyOn(installed, 'inspectInstalledJobRuntimeCandidate').mockResolvedValue()
    vi.spyOn(qualification, 'assertJobRuntimeEntryContext').mockResolvedValue(undefined as never)
    vi.spyOn(OwnedOCIContainer.prototype, 'entered').mockResolvedValue(undefined as never)
    vi.spyOn(OwnedOCIContainer.prototype, 'close').mockResolvedValue(true)
    const children = new Map<object, number>(), spawned: string[][] = [], cid = 'c'.repeat(64)
    let started=false,released=false;const waiting:Array<()=>void>=[]
    const reserveLaunch = vi.fn((owner: string) => ({ root: f.root, owner, launchId: randomUUID() }))
    const registry = { reserveLaunch, closeRegistration: vi.fn(), abandonReservedLaunch: vi.fn(async () => true), closeOwner: vi.fn(async () => true), snapshot: () => ({ revision: '1', launches: [] }) } as unknown as NativeProcessRegistry
    vi.spyOn(processes, 'nativeProcessExit').mockImplementation(child => ({ exitCode: children.get(child) ?? null, exitSignal: null }))
    vi.spyOn(processes, 'spawnNativeProcess').mockImplementation((binary, argv, options) => {
      expect(binary).toBe(f.candidate.fingerprint.runtimeExecutable)
      expect(options.env).toEqual(f.candidate.controllerEnvironment)
      expect(options.env).not.toHaveProperty('HOME'); expect(options.env).not.toHaveProperty('SSH_AUTH_SOCK'); expect(options.env).not.toHaveProperty('GRAPHQL_HEAVY_JOB_TOKEN')
      expect(options.recovery?.owner).toBe(`job:${f.execution.operationId}:${f.execution.owner.grantId}:${f.execution.owner.epoch}`)
      spawned.push([...argv])
      const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() }, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null })
      setImmediate(() => {
        const finish=(output:string)=>{children.set(child,0);child.exitCode=0;child.stdout.end(output);child.stderr.end();child.emit('close',0,null)}
        if(argv.includes('start')){started=true;waiting.push(()=>finish('build failed exit7'));return}
        if(argv.includes('wait')){if(released)finish('7');else waiting.push(()=>finish('7'));return}
        if(argv.includes('exec')){released=true;for(const end of waiting.splice(0))end();finish('');return}
        const output = argv.includes('create') ? cid : JSON.stringify([{ Id: cid,
          Config: { Labels: { 'graphql.job.identity': jobSupervisorIdentity(f.execution), 'graphql.job.spec': f.execution.acceptedSpec.specDigest, 'graphql.job.attempt': f.execution.attemptId } }, State: { Running: started&&!released, Pid: started&&!released?100:0, ExitCode: 7, Status: released?'exited':started?'running':'created' } }])
        finish(output)
      })
      // The reserveLaunch and fsynced Job write occurred BEFORE this entry.
      const journal = JSON.parse(requireRead(f.path, 'utf8'))
      expect(journal.jobOwners[0].launches.some((launch: { launchId: string }) => launch.launchId === options.recovery?.launchId)).toBe(true)
      return child as unknown as ReturnType<typeof processes.spawnNativeProcess>
    })
    const host = createInstalledJobExecutionHost({ journal: f.journal, connection: f.connection, incarnationId: randomUUID(), configuration: { path: join(f.root, 'protected-unit-config'), ownerUid: process.getuid!() }, registry,
      source: { verify: async () => ({ privateRepositoryRoot: f.execution.acceptedSpec.target.destination.canonicalProjectRoot, directoryIdentityHash: f.execution.acceptedSpec.target.destination.directoryIdentityHash, privateGit: true, diskQuotaBytes: 1048576,gitMounts:mountFixture(f.execution,f.candidate.fingerprint.root.binding.filesystem) }) },
      inputs: { prepare: async execution => {
        const path = join(execution.acceptedSpec.target.destination.canonicalProjectRoot, JOB_INPUT_DIRECTORY); await mkdir(path)
        const inputSnapshotDigest = jobInputSnapshotDigest(execution), manifest = Buffer.from(JSON.stringify({ version: 1, inputSnapshotDigest, workflowInput: null, files: [] })), workflow = Buffer.from('null')
        await writeFile(join(path, 'manifest.json'), manifest); await writeFile(join(path, 'workflow-input.json'), workflow)
        const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY), directory = await identity(handle); await handle.close()
        const spec = execution.acceptedSpec
        return { version: 1, bindingId: 'd'.repeat(64), recipient: { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, owner: execution.owner, bindingHash: spec.bindingHash, specDigest: spec.specDigest, materializationId: spec.source.materializationId, materializationDigest: spec.source.materializationDigest }, inputSnapshotDigest, manifestSha256: hash(manifest), manifestByteSize: manifest.length,
          directory: { relativePath: JOB_INPUT_DIRECTORY, ...directory }, files: [{ relativePath: 'manifest.json', sha256: hash(manifest), byteSize: manifest.length }, { relativePath: 'workflow-input.json', sha256: hash(workflow), byteSize: workflow.length }], readonlyMountRequired: true }
      } }, authorize: vi.fn(), observeReceipt: vi.fn(), appendLog: vi.fn(), collectOutputs: vi.fn() })
    try {
      await host.deliver(f.intent, f.execution); await host.drain()
      expect(spawned.filter(argv => argv.includes('create'))).toHaveLength(1)
      expect(spawned.filter(argv => argv.includes('start'))).toHaveLength(1)
      expect(spawned.filter(argv => argv.includes('exec'))).toHaveLength(1)
      expect(await f.journal.jobStatus(f.execution.operationId)).toMatchObject({ status: 'known', receipt: { terminal: { outcome: 'build_failed', exitCode: 7 }, publication: 'complete' } })
      await host.deliver(f.intent, f.execution)
      expect(spawned.filter(argv => argv.includes('create'))).toHaveLength(1)
      expect((await f.journal.jobNativeOwner(f.execution.operationId))?.qualificationOperationId).toBe(f.candidate.operationId)
    } finally { vi.restoreAllMocks() }
  })
})

// Structured source authority double; real receipt/inode guards are tested in sources/repository.test.ts.
function mountFixture(execution:JobExecution,filesystem={device:'1',inode:'2',mountId:'3'}):VerifiedJobGitMounts {
  const spec=execution.acceptedSpec,parent=dirname(spec.target.destination.canonicalProjectRoot),digest='a'.repeat(64)
  return {version:1,layout:JOB_PRIVATE_GIT_LAYOUT,workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,specDigest:spec.specDigest,bindingHash:spec.bindingHash,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest,
    git:{directory:join(parent,'repository'),filesystem,generatedCommit:'4'.repeat(40),sourceCommit:spec.source.commit,repositoryReceiptDigest:digest,configDigest:digest,indexDigest:digest,mountpoint:filesystem},scheduler:{directory:join(parent,'job-heavy-jobs'),filesystem},receiptDigest:digest}
}

// This suite models OCI/native boundaries; original filesystem receipts are independently tested.
vi.mock('./privateGitMounts.js',async original=>{const actual=await original<typeof import('./privateGitMounts.js')>();return {...actual,verifyJobGitMounts:vi.fn(async()=>{})}})
