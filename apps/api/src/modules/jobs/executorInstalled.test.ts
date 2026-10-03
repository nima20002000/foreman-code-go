import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteJobDispatchIntent } from '@graphql/contracts/remote-job-execution'
import { jobSpecDigests } from '@graphql/contracts/jobs-node'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { identity } from '../sources/privateFilesystem.js'
import * as privateFilesystem from '../sources/privateFilesystem.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { RemoteJobExecutionHost, RemoteJobExecutionHostPorts } from '../runs/remote/jobExecutionHost.js'
import { createInstalledJobExecutionHost } from './executorInstalled.js'
import * as installed from './installedRuntimeHost.js'
import * as git from './privateGitMounts.js'
import type { QualifiedJobProfile } from './executor.js'

const roots: string[] = [], journals: RemoteOperationJournal[] = [], hosts: RemoteJobExecutionHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.drain()))
  vi.restoreAllMocks()
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function filesystem(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { return await identity(handle) } finally { await handle.close() }
}
async function fixture(qualifiedFilesystem?: { device?: string; mountId?: string }) {
  const root = await mkdtemp(join(tmpdir(), 'hrt-installed-job-')); roots.push(root)
  const execution = jobExecution(), parent = join(root, execution.acceptedSpec.source.materializationId)
  await mkdir(parent, { mode: 0o700 })
  for (const directory of ['tree', 'repository', 'job-heavy-jobs']) await mkdir(join(parent, directory), { mode: 0o700 })
  Object.assign(execution.acceptedSpec.target.destination, { canonicalProjectRoot: join(parent, 'tree'), canonicalCwd: join(parent, 'tree'), managedRuntimeRoot: join(root, 'runtime') })
  Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, execution.acceptedSpec.workflowInput))
  const spec = execution.acceptedSpec, digest = 'a'.repeat(64), bootId = bootIdentity()
  const mounts: git.VerifiedJobGitMounts = { version: 1, layout: git.JOB_PRIVATE_GIT_LAYOUT, workspaceId: execution.workspaceId,
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, owner: structuredClone(execution.owner),
    specDigest: spec.specDigest, bindingHash: spec.bindingHash, materializationId: spec.source.materializationId, materializationDigest: spec.source.materializationDigest,
    git: { directory: join(parent, 'repository'), filesystem: await filesystem(join(parent, 'repository')), generatedCommit: '4'.repeat(40), sourceCommit: spec.source.commit,
      repositoryReceiptDigest: digest, configDigest: digest, indexDigest: digest, mountpoint: await filesystem(join(parent, 'repository')) },
    scheduler: { directory: join(parent, 'job-heavy-jobs'), filesystem: await filesystem(join(parent, 'job-heavy-jobs')) }, receiptDigest: digest }
  const profile: QualifiedJobProfile = { workspaceLayout: git.JOB_PRIVATE_GIT_LAYOUT, policyId: spec.policy.isolationPolicyId,
    policyRevision: spec.policy.isolationPolicyRevision, imageDigest: spec.policy.imageDigest, toolchainDigest: spec.policy.toolchainDigest,
    runtimeVersion: 'fixture', ociRuntimeVersion: 'fixture', kernelVersion: 'fixture', qualificationId: randomUUID(), rootless: true,
    cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none', cpuLimit: 1, memoryBytes: 1048576, pidsLimit: 64, diskBytes: 1048576 }
  // Qualification is a supplied measurement double. Directory checks below use real Linux FDs.
  const fingerprint = { bootId, root: { binding: { filesystem: { ...await filesystem(root), ...qualifiedFilesystem } } } }
  const qualified = { candidate: { fingerprint, sourceParent: root, runtimeRoot: spec.target.destination.managedRuntimeRoot,
    qualificationId: profile.qualificationId, approvalId: randomUUID() }, admission: { fingerprintDigest: digest },
    result: { outcome: 'qualified', measurement: { runtime: profile, fingerprint, fingerprintDigest: digest,
      qualificationId: profile.qualificationId, expiresAt: new Date(Date.now() + 60000).toISOString(), approvalId: '' } } }
  qualified.result.measurement.approvalId = qualified.candidate.approvalId
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true }); journals.push(journal)
  vi.spyOn(journal, 'qualifiedJobRuntime').mockResolvedValue(qualified as unknown as Awaited<ReturnType<RemoteOperationJournal['qualifiedJobRuntime']>>)
  const inspect = vi.spyOn(installed, 'inspectInstalledJobRuntimeCandidate').mockResolvedValue(undefined)
  const verify = vi.spyOn(git, 'verifyJobGitMounts').mockResolvedValue(undefined)
  const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: spec.target.mainId,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: spec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: spec.bindingHash,
    inputDigest: `sha256:${spec.specDigest}`, owner: execution.owner }
  const connection = { kind: 'main' as const, mainId: intent.mainId, mainInstallationId: spec.target.mainInstallationId, bootId }
  const source: Awaited<ReturnType<RemoteJobExecutionHostPorts['source']['verify']>> = {
    privateRepositoryRoot: spec.target.destination.canonicalProjectRoot, directoryIdentityHash: spec.target.destination.directoryIdentityHash,
    privateGit: true, diskQuotaBytes: 1024, gitMounts: mounts }
  const inputs = { prepare: vi.fn(async () => { throw new Error('Stop after source verification') }) }
  const registry = { reserveLaunch: vi.fn(() => { throw new Error('No OCI entry expected') }) }
  const host = createInstalledJobExecutionHost({ journal, connection, incarnationId: randomUUID(), registry: registry as unknown as NativeProcessRegistry,
    configuration: null, source: { verify: vi.fn(async () => source) }, inputs, authorize: vi.fn(async () => {}),
    appendLog: vi.fn(), observeReceipt: vi.fn(), collectOutputs: vi.fn() }); hosts.push(host)
  await journal.jobAccept(intent, execution, connection, randomUUID())
  const ports = Reflect.get(host, 'ports') as RemoteJobExecutionHostPorts
  if (typeof ports.supervisor !== 'function') throw new Error('Installed supervisor factory missing')
  await ports.supervisor(execution)
  const check = (signal = new AbortController().signal) => ports.source.verify(structuredClone(spec), signal)
  return { root, execution, source, mounts, journal, qualified, inspect, verify, check, ports, host, intent, registry, inputs }
}
describe('installed Job original Git/scheduler propagation', () => {
  it('retains the full original execution and independently checks both real mount directories', async () => {
    const f = await fixture(), original = structuredClone(f.execution)
    expect(await f.check()).toBe(f.source)
    expect(f.verify).toHaveBeenCalledWith(original, f.source)
    f.execution.owner.epoch = '2'
    await expect(f.check()).resolves.toBe(f.source)
    expect(f.verify.mock.calls.at(-1)?.[0]).toEqual(original)
  })
  it.each(['missing', 'old'] as const)('rejects %s layout before OCI entry', async kind => {
    const f = await fixture()
    if (kind === 'missing') delete f.source.gitMounts
    else Object.assign(f.mounts, { layout: 'source-inputs-v0' })
    await f.host.deliver(f.intent, f.execution); await f.host.drain()
    const status = await f.journal.jobStatus(f.intent.operationId)
    expect(status.status === 'known' && status.receipt.terminal?.outcome).toBe('preparation_failed')
    expect(status.status === 'known' && status.receipt.entryAttempted).toBe(false)
    expect(f.registry.reserveLaunch).not.toHaveBeenCalled(); expect(f.inputs.prepare).not.toHaveBeenCalled()
  })
  it.each(['workspaceId', 'executionId', 'attemptId', 'operationId', 'specDigest', 'bindingHash', 'materializationId', 'materializationDigest'] as const)('rejects substituted %s', async field => {
    const f = await fixture(); f.mounts[field] = 'foreign'
    await expect(f.check()).rejects.toThrow('Original qualified Job Git/scheduler mounts')
    expect(f.verify).not.toHaveBeenCalled()
  })
  it.each(['grantId', 'epoch'] as const)('rejects substituted owner %s', async field => {
    const f = await fixture(); f.mounts.owner[field] = 'foreign'
    await expect(f.check()).rejects.toThrow('Original qualified Job Git/scheduler mounts')
  })
  it('propagates the read-only leaf rejection', async () => {
    const f = await fixture(); f.verify.mockRejectedValue(new Error('Retained Git receipt changed'))
    await expect(f.check()).rejects.toThrow('Retained Git receipt changed')
  })
  it.each(['git', 'scheduler'] as const)('rejects replaced %s inode', async mount => {
    const f = await fixture(), path = f.mounts[mount].directory
    await rename(path, `${path}.original`); await mkdir(path, { mode: 0o700 })
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
  })
  it.each(['git', 'scheduler'] as const)('rejects symlinked %s directory', async mount => {
    const f = await fixture(), path = f.mounts[mount].directory
    await rename(path, `${path}.original`); await symlink(`${path}.original`, path)
    await expect(f.check()).rejects.toThrow()
  })
  it.each(['device', 'mountId'] as const)('rejects a different qualified %s', async field => {
    const f = await fixture({ [field]: '0' })
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
  })
  it('rejects ambiguous original admissions without choosing a replacement execution', async () => {
    const f = await fixture(), execution = structuredClone(f.execution); execution.operationId = 'second-operation'
    const supervisor = f.ports.supervisor as (execution: typeof f.execution) => Promise<unknown>
    await supervisor(execution)
    await expect(f.check()).rejects.toThrow('Unique original installed Job admission')
  })
  it.each(['git', 'scheduler'] as const)('rejects a foreign %s filesystem despite a passing leaf double', async mount => {
    const f = await fixture()
    const observedFilesystem = f.mounts[mount].filesystem
    f.mounts[mount].filesystem = { ...observedFilesystem, inode: '0' }
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
    expect(await filesystem(f.mounts[mount].directory)).toEqual(observedFilesystem)
  })
  it.each([
    ['git', 'device'], ['git', 'mountId'], ['scheduler', 'device'], ['scheduler', 'mountId'],
  ] as const)('independently rejects a nested %s %s', async (mount, field) => {
    const f = await fixture(), readIdentity = privateFilesystem.identity
    vi.spyOn(privateFilesystem, 'identity').mockImplementation(async handle => {
      const observed = await readIdentity(handle)
      return await realpath(`/proc/self/fd/${handle.fd}`) === f.mounts[mount].directory ? { ...observed, [field]: '0' } : observed
    })
    await expect(f.check()).rejects.toThrow('qualified filesystem or identity')
  })
  it('rechecks the original journal owner after asynchronous leaf verification', async () => {
    const f = await fixture()
    f.verify.mockImplementation(async () => { await f.journal.jobControl({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.execution.operationId, attemptId: f.execution.attemptId, executionId: f.execution.id,
      bindingHash: f.execution.acceptedSpec.bindingHash, subject: f.intent.subject, owner: f.execution.owner, action: { kind: 'stop' } }) })
    await expect(f.check()).rejects.toThrow('Original Job source owner changed')
  })
  it('checks cancellation after asynchronous source verification', async () => {
    const f = await fixture(), controller = new AbortController()
    f.verify.mockImplementation(async () => { controller.abort(new Error('Cancelled original preparation')) })
    await expect(f.check(controller.signal)).rejects.toThrow('Cancelled original preparation')
  })
  it('rejects missing original admission when protected runtime inspection fails', async () => {
    const f = await fixture(); f.inspect.mockRejectedValue(new Error('Old layout'))
    const other = structuredClone(f.execution); other.operationId = 'other'; other.acceptedSpec.specDigest = 'f'.repeat(64)
    await (f.ports.supervisor as (execution: typeof other) => Promise<unknown>)(other)
    await expect(f.ports.source.verify(other.acceptedSpec, new AbortController().signal)).rejects.toThrow('original installed Job admission')
  })
})
