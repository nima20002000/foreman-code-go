import type { JobExecution } from '@graphql/contracts/jobs'
import { JOB_PRIVATE_GIT_LAYOUT, JOB_GIT_ENVIRONMENT, type VerifiedJobGitMounts } from './privateGitMounts.js'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JOB_INPUT_DIRECTORY, type JobInputDeliveryReceipt } from '@graphql/contracts/job-inputs'
import { jobInputSnapshotDigest } from '@graphql/contracts/job-inputs-node'
import { jobSpecDigests } from '@graphql/contracts/jobs-node'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { identity } from '../sources/privateFilesystem.js'
import { jobSupervisorIdentity, type JobLaunchPlan, type QualifiedJobProfile } from './executor.js'
import { OwnedOCIContainer, type OCIContainerOwnership } from './executorContainerOwner.js'
import { PodmanJobSupervisor, podmanCreateArgv, type PodmanCommandRunner } from './executorPodman.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ci-oci-input-')); roots.push(root)
  const sourceRoot = join(root, '11111111-1111-4111-8111-111111111111','tree'), runtimeRoot = join(root, 'runtime')
  await mkdir(dirname(sourceRoot),{mode:0o700});await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(runtimeRoot, { mode: 0o700 }); const inputRoot = join(sourceRoot, JOB_INPUT_DIRECTORY); await mkdir(inputRoot)
  const execution = jobExecution(); const digest = 'a'.repeat(64)
  const sourceHandle = await open(sourceRoot, constants.O_RDONLY | constants.O_DIRECTORY), inputsHandle = await open(inputRoot, constants.O_RDONLY | constants.O_DIRECTORY)
  const sourceIdentity = await identity(sourceHandle), inputIdentity = await identity(inputsHandle); await sourceHandle.close(); await inputsHandle.close()
  execution.acceptedSpec.inputs = []; execution.acceptedSpec.workflowInput = null; execution.workflow = null
  Object.assign(execution.acceptedSpec.target.destination, { canonicalProjectRoot: sourceRoot, canonicalCwd: sourceRoot, directoryIdentityHash: hash(Buffer.from(JSON.stringify(sourceIdentity))), managedRuntimeRoot: runtimeRoot })
  Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, null))
  const inputDigest = jobInputSnapshotDigest(execution)
  const files = [{ relativePath: 'manifest.json', bytes: Buffer.from(JSON.stringify({ version: 1, inputSnapshotDigest: inputDigest, workflowInput: null, files: [] })) }, { relativePath: 'workflow-input.json', bytes: Buffer.from('null') }]
  for (const file of files) await writeFile(join(inputRoot, file.relativePath), file.bytes, { mode: 0o444 })
  const spec = execution.acceptedSpec
  const receipt: JobInputDeliveryReceipt = { version: 1, recipient: { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, owner: { ...execution.owner }, bindingHash: spec.bindingHash, specDigest: spec.specDigest, materializationId: spec.source.materializationId, materializationDigest: spec.source.materializationDigest }, bindingId: digest, inputSnapshotDigest: inputDigest, manifestSha256: hash(files[0]!.bytes), manifestByteSize: files[0]!.bytes.length, directory: { relativePath: JOB_INPUT_DIRECTORY, ...inputIdentity }, files: files.map(file => ({ relativePath: file.relativePath, sha256: hash(file.bytes), byteSize: file.bytes.length })), readonlyMountRequired: true }
  const profile: QualifiedJobProfile = { workspaceLayout:JOB_PRIVATE_GIT_LAYOUT, policyId: spec.policy.isolationPolicyId, policyRevision: spec.policy.isolationPolicyRevision, imageDigest: spec.policy.imageDigest, toolchainDigest: spec.policy.toolchainDigest, qualificationId: 'unit-double', runtimeVersion: 'unit-double', ociRuntimeVersion: 'unit-double', kernelVersion: 'unit-double', rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none', cpuLimit: 1, memoryBytes: 1024, pidsLimit: 64, diskBytes: 1024 * 1024 }
  const source = { privateRepositoryRoot: sourceRoot, directoryIdentityHash: spec.target.destination.directoryIdentityHash, privateGit: true as const, diskQuotaBytes: 1024 * 1024,gitMounts:mountFixture(execution,sourceIdentity) }
  const plan: JobLaunchPlan = { identity: jobSupervisorIdentity(execution), execution, verifiedSource: source, inputs: receipt, privateRepositoryRoot: sourceRoot, cwd: sourceRoot, argv: ['node', 'failure.mjs'], environment: {}, stdin: 'closed', pty: false, profile }
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  let stopped = false; let resolveWait: ((value: { exitCode: number; stdout: string }) => void) | undefined
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('create')) return { exitCode: 0, stdout: digest }
    if (argv[0] === 'wait') return new Promise<{ exitCode: number; stdout: string }>(resolve => { resolveWait = resolve; if (stopped) resolve({ exitCode: 0, stdout: '7' }) })
    return { exitCode: 0, stdout: JSON.stringify([{ Id: digest, Config: { Labels: { 'graphql.job.identity': plan.identity, 'graphql.job.spec': spec.specDigest, 'graphql.job.attempt': execution.attemptId } }, State: { Running: !stopped, Pid: stopped ? 0 : 100, ExitCode: 7, Status: stopped ? 'exited' : 'running' } }]) }
  })
  const commands: PodmanCommandRunner = { run, attach: vi.fn(async () => child as unknown as Awaited<ReturnType<PodmanCommandRunner['attach']>>) }
  const ownership = { reserveContainerIntent: vi.fn(), assertCurrent: vi.fn(), bindContainer: vi.fn(), launchHelpers: vi.fn(), readCertificate: vi.fn(), publish: vi.fn() } as unknown as OCIContainerOwnership
  // Boundary supervision doubles only. Physical PID/cgroup certificate tests are separate.
  vi.spyOn(OwnedOCIContainer.prototype, 'entered').mockImplementation(async () => { throw new Error('unit boundary marker') })
  vi.spyOn(OwnedOCIContainer.prototype, 'close').mockResolvedValue(false)
  const supervisor = new PodmanJobSupervisor(profile, commands, async () => ownership)
  return { root, inputRoot, execution, receipt, plan, supervisor, run, ownership, commands, child, stop: () => { stopped = true; resolveWait?.({ exitCode: 0, stdout: '7' }) } }
}
describe('OCI immutable input consumer with command/boundary doubles, no live qualification', () => {
  it('emits the exact retained input RO submount and fixed manifest environment', async () => {
    const f = await fixture(); const argv = podmanCreateArgv(f.plan)
    expect(argv).toContain(`type=bind,src=${f.inputRoot},dst=/workspace/${JOB_INPUT_DIRECTORY},ro`)
    expect(argv).toContain('GRAPHQL_JOB_INPUT_MANIFEST=/workspace/.graphql-job-inputs/manifest.json')
    expect(argv).toContain('--remote=false')
    expect(argv.filter(value=>value.startsWith('type=bind,'))).toHaveLength(4)
    expect(argv).toContain(`type=bind,src=${f.plan.verifiedSource.gitMounts!.git.directory},dst=/graphql-job-git,ro`)
    expect(argv).toContain(`type=bind,src=${f.plan.verifiedSource.gitMounts!.scheduler.directory},dst=/graphql-job-git/graphql-heavy-jobs,rw`)
    for(const [key,value] of Object.entries(JOB_GIT_ENVIRONMENT))expect(argv).toContain(`${key}=${value}`)
  })
  it('rehashes physical bytes before any create or ownership publication', async () => {
    const f = await fixture(); await chmod(join(f.inputRoot, 'workflow-input.json'), 0o644); await writeFile(join(f.inputRoot, 'workflow-input.json'), 'true')
    await expect(f.supervisor.launch(f.plan)).rejects.toThrow('Accepted job inputs rejected')
    expect(f.run).not.toHaveBeenCalled(); expect(f.ownership.bindContainer).not.toHaveBeenCalled()
  })
  it('rejects stale owner/input receipts before native entry', async () => {
    const f = await fixture(); f.plan.inputs.recipient.owner.epoch = '999'
    await expect(f.supervisor.launch(f.plan)).rejects.toThrow('original execution')
    expect(f.run).not.toHaveBeenCalled()
  })
  it('does not launch user work successfully when owned boundary entry is unconfirmed', async () => {
    const f = await fixture()
    await expect(f.supervisor.launch(f.plan)).rejects.toThrow('unit boundary marker')
    expect(f.ownership.bindContainer).toHaveBeenCalledWith(f.plan.identity, 'a'.repeat(64))
    f.stop()
  })
  it('rearms the persisted deadline on recovery and stops locally without a launch', async () => {
    const f = await fixture(), markTimeout = vi.fn(), deadlineMs = vi.fn(async () => Date.now() + 5)
    const recovered = new PodmanJobSupervisor(f.plan.profile, f.commands, async () => f.ownership, { deadlineMs, markTimeout, isTimedOut: async () => false })
    const stop = vi.spyOn(recovered, 'stopExecution').mockResolvedValue(true)
    vi.useFakeTimers()
    try {
      expect(await recovered.reconcile(f.execution)).toMatchObject({ stopped: false, exitCode: null })
      await vi.advanceTimersByTimeAsync(10)
      expect(markTimeout).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledWith(f.execution, f.execution.acceptedSpec.policy.cancellationGraceMs, 'a'.repeat(64))
      expect(f.run.mock.calls.some(([argv]) => argv.includes('create') || argv.includes('start'))).toBe(false)
    } finally { vi.useRealTimers() }
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

it('denies historical two-mount profile and arbitrary host Git before any create',async()=>{
  const f=await fixture();delete f.plan.profile.workspaceLayout
  await expect(f.supervisor.launch(f.plan)).rejects.toThrow('Qualified isolation unavailable')
  expect(f.run).not.toHaveBeenCalled()
  f.plan.profile.workspaceLayout=JOB_PRIVATE_GIT_LAYOUT;f.plan.verifiedSource.gitMounts!.git.directory='/unrelated/.git'
  expect(()=>podmanCreateArgv(f.plan)).toThrow('Original qualified')
})
