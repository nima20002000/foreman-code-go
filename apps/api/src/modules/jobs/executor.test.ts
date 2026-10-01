import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JobExecution } from '@graphql/contracts'
import { executeJob, jobSpecDigests, jobSupervisorIdentity, type JobExecutorPorts, type JobSupervisedProcess, type QualifiedJobProfile } from './executor.js'
import { podmanCreateArgv } from './executorPodman.js'
import { readDeclaredJobOutputs } from './executorOutputs.js'

const id = '00000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
const profile: QualifiedJobProfile = { policyId: id, policyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest,
  runtimeVersion: 'qualified-test', ociRuntimeVersion: 'qualified-test', kernelVersion: 'qualified-test', qualificationId: id,
  rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none',
  cpuLimit: 1, memoryBytes: 1024, pidsLimit: 64, diskBytes: 1024 }
function execution(): JobExecution {
  const job: JobExecution = { schemaVersion: 1, id, workspaceId: id, operationId: id, attemptId: id, owner: { grantId: id, epoch: '1' }, workflow: null,
    process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false }, transport: 'connected', publication: 'pending',
    cancelRequestedAt: null, startedAt: null, finishedAt: null, lastSeenAt: null, resultIssue: null,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', acceptedSpec: {
      definitionId: id, definitionRevision: 1, definitionVersionId: id, scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest,
      source: { approvedSourceId: id, snapshotId: id, commit: 'a'.repeat(40), manifestDigest: digest, materializationId: id, materializationDigest: digest },
      target: { schemaVersion: 1, mainId: id, hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id,
        destination: { canonicalProjectRoot: '/private/source', canonicalCwd: '/private/source', managedRuntimeRoot: '/private/runtime', directoryIdentityHash: digest,
          rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1', attestationId: id, attestationHash: digest } },
      argv: ['node', 'fixture.mjs', '$(touch /escape); &'], inputs: [], outputs: [],
      policy: { isolationPolicyId: id, isolationPolicyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest, environmentScopeRefs: [], network: 'none',
        queueTimeoutMs: 10000, preparationTimeoutMs: 1000, executionTimeoutMs: 1000, cancellationGraceMs: 1, maxLogChunkBytes: 8,
        maxLogBytes: 1024, maxWorkerSpoolBytes: 1024, logOverflow: 'stop', maxOutputBytes: 1024, retentionSeconds: 1000 } } }
  repin(job)
  return job
}
function repin(job: JobExecution) {
  const { source, target, argv, inputs, policy, outputs } = job.acceptedSpec
  Object.assign(job.acceptedSpec, jobSpecDigests({ source, target, argv, inputs, policy, outputs }))
}
async function* chunks(value = '') { if (value) yield Buffer.from(value) }
function ports(exit: { exitCode: number | null; signal: string | null; execError?: string; timedOut?: boolean } = { exitCode: 0, signal: null }): JobExecutorPorts {
  const process: JobSupervisedProcess = { stdout: chunks('stdout'), stderr: chunks('stderr'), exited: Promise.resolve(exit),
    stop: vi.fn(async () => true), proveStopped: vi.fn(async () => true) }
  return { authority: { recheck: vi.fn(async () => {}), claim: vi.fn(async () => 'launch' as const), launched: vi.fn(async () => {}) },
    source: { verify: vi.fn(async () => ({ privateRepositoryRoot: '/private/source', directoryIdentityHash: digest, privateGit: true as const, diskQuotaBytes: 1024 })) },
    supervisor: { qualifiedProfile: profile, launch: vi.fn(async () => process) }, appendLog: vi.fn(async () => {}), collectOutputs: vi.fn(async () => {}) }
}

describe('noninteractive worker job executor (supervisor doubles, not live isolation proof)', () => {
  it('preserves argv and closes stdin without inherited credentials', async () => {
    const p = ports()
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result.outcome).toBe('succeeded')
    const plan = vi.mocked(p.supervisor.launch).mock.calls[0]![0]
    expect(plan.argv[2]).toBe('$(touch /escape); &')
    expect(plan.environment).toEqual({ HOME: '/tmp/job-home', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1' })
    expect(plan.stdin).toBe('closed')
    expect(plan.pty).toBe(false)
    const argv = podmanCreateArgv(plan)
    expect(argv).toContain('--network=none')
    expect(argv).toContain('--pull=never')
    expect(argv.at(-1)).toBe('$(touch /escape); &')
  })
  it.each([[{ exitCode: 7, signal: null }, 'build_failed'], [{ exitCode: null, signal: null, execError: 'ENOENT' }, 'spawn_failed']] as const)('distinguishes exec failure from exit7', async (exit, outcome) => {
    expect((await executeJob(execution(), ports(exit), new AbortController().signal)).outcome).toBe(outcome)
  })
  it('fails closed on unavailable isolation or changed root before any claim/spawn', async () => {
    for (const rootChanged of [false, true]) {
      const p = ports()
      if (rootChanged) p.source.verify = async () => ({ privateRepositoryRoot: '/other', directoryIdentityHash: digest, privateGit: true, diskQuotaBytes: 1024 })
      else p.supervisor.qualifiedProfile = null
      expect((await executeJob(execution(), p, new AbortController().signal)).outcome).toBe('preparation_failed')
      expect(p.authority.claim).not.toHaveBeenCalled()
      expect(p.supervisor.launch).not.toHaveBeenCalled()
    }
  })
  it('queued cancellation produces zero spawn', async () => {
    const p = ports(); const cancel = new AbortController(); cancel.abort()
    expect((await executeJob(execution(), p, cancel.signal)).outcome).toBe('cancelled')
    expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
  it('running cancellation settles only after the supervisor confirms descendant closure', async () => {
    const p = ports(); const cancel = new AbortController(); const proof: string[] = []
    let finish!: (exit: { exitCode: number | null; signal: string | null }) => void
    p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: new Promise(resolve => { finish = resolve }), proveStopped: async () => false,
      stop: async () => { proof.push('TERM', 'KILL', 'container-descendants-empty'); finish({ exitCode: null, signal: 'SIGKILL' }); return true } })
    p.authority.launched = async () => { cancel.abort() }
    p.collectOutputs = async () => { expect(proof).toContain('container-descendants-empty') }
    expect(await executeJob(execution(), p, cancel.signal)).toMatchObject({ outcome: 'cancelled', processStopped: true })
  })
  it('rejects accepted argv tampering and stale launch authority without spawning', async () => {
    const p = ports(); const job = execution(); job.acceptedSpec.argv.push('changed')
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.supervisor.launch).not.toHaveBeenCalled()
    const denied = ports(); denied.authority.recheck = async () => { throw Error('stale owner') }
    expect((await executeJob(execution(), denied, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(denied.authority.claim).not.toHaveBeenCalled()
  })
  it('enforces preparation budget before claim even when source verification stalls', async () => {
    const p = ports(); const job = execution(); job.acceptedSpec.policy.preparationTimeoutMs = 5; repin(job)
    p.source.verify = () => new Promise(() => {})
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.authority.claim).not.toHaveBeenCalled()
  })
  it('does not rewrite a natural exit when cancellation arrives after observed completion', async () => {
    const p = ports(); const cancel = new AbortController()
    p.authority.launched = async () => { await Promise.resolve(); cancel.abort() }
    expect((await executeJob(execution(), p, cancel.signal)).outcome).toBe('succeeded')
  })
  it('preserves UTF8 split across pipe chunks and exact serialized byte sizes', async () => {
    const p = ports()
    async function* unicode() { yield Buffer.from([0xf0, 0x9f]); yield Buffer.from([0x98, 0x80]) }
    p.supervisor.launch = async () => ({ stdout: unicode(), stderr: chunks(), exited: Promise.resolve({ exitCode: 0, signal: null }), stop: async () => true, proveStopped: async () => true })
    await executeJob(execution(), p, new AbortController().signal)
    expect(vi.mocked(p.appendLog).mock.calls.map(([chunk]) => chunk.text).join('')).toBe('😀')
    expect(vi.mocked(p.appendLog).mock.calls[0]![0].byteSize).toBe(4)
  })
  it('explicit truncation caps persisted logs without silently losing their status', async () => {
    const p = ports(); const job = execution(); job.acceptedSpec.policy.maxLogBytes = 4; job.acceptedSpec.policy.logOverflow = 'explicit-truncation'; repin(job)
    const result = await executeJob(job, p, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'succeeded', logsTruncated: true })
    expect(p.appendLog).not.toHaveBeenCalled()
  })
  it('duplicate dispatch or restart requires reconciliation and never launches again', async () => {
    const p = ports(); p.authority.claim = async () => 'reconcile'
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result.recoveryRequired).toBe(true)
    expect(result.processStopped).toBe(false)
    expect(p.supervisor.launch).not.toHaveBeenCalled()
    expect(jobSupervisorIdentity(execution())).toBe(jobSupervisorIdentity(execution()))
  })
  it('lost launch acknowledgment preserves observed exit', async () => {
    const p = ports({ exitCode: 7, signal: null }); p.authority.launched = async () => { throw Error('offline') }
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'build_failed', exitCode: 7, recoveryRequired: true })
  })
  it('offline deadline requires descendant stop proof before terminal timeout', async () => {
    const p = ports(); const job = execution(); job.transport = 'offline'; job.acceptedSpec.policy.executionTimeoutMs = 5
    repin(job)
    let resolveExit!: (exit: { exitCode: number | null; signal: string | null }) => void
    p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: new Promise(resolve => { resolveExit = resolve }),
      stop: async () => { resolveExit({ exitCode: null, signal: 'SIGKILL' }); return false }, proveStopped: async () => false })
    const result = await executeJob(job, p, new AbortController().signal)
    expect(result).toMatchObject({ processStopped: false, outcome: null, recoveryRequired: true })
    expect(p.collectOutputs).not.toHaveBeenCalled()
  })
  it('retains a concrete supervisor deadline even if its watchdog wins the executor timer race', async () => {
    expect((await executeJob(execution(), ports({ exitCode: 143, signal: null, timedOut: true }), new AbortController().signal)).outcome).toBe('timed_out')
  })
  it('bounds logs and keeps exit outcome when spool/publication fail', async () => {
    const p = ports({ exitCode: 7, signal: null }); p.appendLog = async () => { throw Error('disk full') }
    p.collectOutputs = async () => { throw Error('output missing') }
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'build_failed', exitCode: 7, logError: true, outputCollectionError: true })
  })
  it('refuses escaped or unproven descendants after natural exit', async () => {
    const p = ports(); p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: Promise.resolve({ exitCode: 0, signal: null }),
      stop: async () => false, proveStopped: async () => false })
    expect(await executeJob(execution(), p, new AbortController().signal)).toMatchObject({ outcome: null, recoveryRequired: true, processStopped: false })
    expect(p.collectOutputs).not.toHaveBeenCalled()
  })
  it('rejects output symlinks and enforces declared total bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-output-test-'))
    try {
      await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/result'), 'result'); await symlink('result', join(root, 'dist/link'))
      const spec = execution().acceptedSpec; spec.outputs = [{ path: 'dist/link', required: true, mediaType: 'text/plain' }]
      await expect(readDeclaredJobOutputs(root, spec)).rejects.toThrow()
      spec.outputs[0]!.path = 'dist/result'; spec.policy.maxOutputBytes = 3
      await expect(readDeclaredJobOutputs(root, spec)).rejects.toThrow('byte budget')
      spec.policy.maxOutputBytes = 20
      expect((await readDeclaredJobOutputs(root, spec))[0]!.bytes.toString()).toBe('result')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
