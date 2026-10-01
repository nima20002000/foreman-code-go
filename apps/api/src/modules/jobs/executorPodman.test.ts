import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { JobExecution } from '@graphql/contracts'
import { jobSupervisorIdentity, type JobLaunchPlan, type QualifiedJobProfile } from './executor.js'
import { PodmanJobSupervisor, type PodmanCommandRunner } from './executorPodman.js'

const hash = 'a'.repeat(64)
const execution = { id: 'job', attemptId: 'attempt', operationId: 'operation', owner: { grantId: 'grant', epoch: '1' }, acceptedSpec: {
  specDigest: hash, target: { destination: { managedRuntimeRoot: '/private/runtime' } },
  policy: { maxWorkerSpoolBytes: 1024, preparationTimeoutMs: 1000, executionTimeoutMs: 10000, cancellationGraceMs: 500 },
} } as JobExecution
const profile = { qualificationId: 'approved' } as QualifiedJobProfile
function fixture() {
  let stopped = false
  let mismatch = false
  let resolveWait: ((result: { exitCode: number; stdout: string }) => void) | undefined
  const stop = () => { stopped = true; resolveWait?.({ exitCode: 0, stdout: '7' }) }
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  const run = vi.fn(async (argv: string[]) => {
    if (argv[0] === 'create') return { exitCode: 0, stdout: hash }
    if (argv[0] === 'wait') return new Promise<{ exitCode: number; stdout: string }>(resolve => { resolveWait = resolve; if (stopped) resolve({ exitCode: 0, stdout: '7' }) })
    if (argv[0] === 'stop') { stop(); return { exitCode: 0, stdout: '' } }
    return { exitCode: 0, stdout: JSON.stringify([{ Id: hash, Config: { Labels: {
      'graphql.job.identity': jobSupervisorIdentity(execution), 'graphql.job.spec': mismatch ? 'bad' : hash, 'graphql.job.attempt': 'attempt',
    } }, State: { Running: !stopped, Pid: stopped ? 0 : 100, ExitCode: 7, Status: stopped ? 'exited' : 'running' } }]) }
  })
  const commands: PodmanCommandRunner = { run, attach: vi.fn(() => child as unknown as ReturnType<PodmanCommandRunner['attach']>) }
  const plan: JobLaunchPlan = { identity: jobSupervisorIdentity(execution), execution, privateRepositoryRoot: '/private/repository', cwd: '/private/repository',
    argv: ['node', 'failure.mjs'], environment: {}, stdin: 'closed', pty: false, profile }
  return { commands, run, child, plan, supervisor: new PodmanJobSupervisor(profile, commands), stop, corrupt: () => { mismatch = true } }
}
describe('production OCI supervisor with command doubles (no installed runtime claim)', () => {
  it('attributes create/start/wait/inspect exit to the exact labeled container', async () => {
    const f = fixture(); const process = await f.supervisor.launch(f.plan)
    f.stop(); f.child.emit('close', 7)
    expect(await process.exited).toEqual({ exitCode: 7, signal: null })
    expect(await process.proveStopped()).toBe(true)
    expect(f.run).toHaveBeenCalledWith(['wait', '--condition=exited', hash], 40500)
    expect(f.commands.attach).toHaveBeenCalledWith(['start', '--attach', '--sig-proxy=false', hash])
  })
  it('signals only the verified immutable container ID and proves closure', async () => {
    const f = fixture(); const process = await f.supervisor.launch(f.plan)
    expect(await process.stop(500)).toBe(true)
    expect(f.run).toHaveBeenCalledWith(['stop', '--time', '1', hash], 30500)
  })
  it('refuses to signal a mismatched ownership label', async () => {
    const f = fixture(); const process = await f.supervisor.launch(f.plan); f.corrupt()
    await expect(process.stop(1)).rejects.toThrow('evidence mismatch')
    expect(f.run.mock.calls.some(([argv]) => argv[0] === 'stop' || argv[0] === 'kill')).toBe(false)
  })
  it('missing recovery identity is uncertainty and never creates another container', async () => {
    const f = fixture(); f.commands.run = vi.fn(async () => ({ exitCode: 1, stdout: '' }))
    expect(await f.supervisor.reconcile(execution)).toBe(null)
    expect(f.commands.run).toHaveBeenCalledOnce()
    expect(f.commands.attach).not.toHaveBeenCalled()
  })
  it('does not project a running container default exit code as observed completion', async () => {
    const f = fixture()
    expect(await f.supervisor.reconcile(execution)).toMatchObject({ stopped: false, exitCode: null, logGapPossible: true })
  })
})
