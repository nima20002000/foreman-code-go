import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { AcceptedJobSpecSchema, JobExecutionSchema, type AcceptedJobSpec, type PreparedJobSpec, type JobExecution } from '@graphql/contracts'
import { jobSpecDigests } from '@graphql/contracts/jobs-node'
export { jobSpecDigests } from '@graphql/contracts/jobs-node'

/** These ports are supplied by W08/W09/W07, never by the untrusted build. */
export interface JobLaunchAuthority {
  recheck(execution: JobExecution): Promise<void>
  claim(execution: JobExecution, supervisorIdentity: string): Promise<'launch' | 'cancelled' | 'reconcile'>
  launched(execution: JobExecution, supervisorIdentity: string, containerId?: string): Promise<void>
}
export interface JobSourcePort {
  verify(spec: AcceptedJobSpec, signal: AbortSignal): Promise<{ privateRepositoryRoot: string; directoryIdentityHash: string; privateGit: true; diskQuotaBytes: number }>
}
export interface QualifiedJobProfile {
  policyId: string
  policyRevision: number
  imageDigest: string
  toolchainDigest: string
  runtimeVersion: string
  ociRuntimeVersion: string
  kernelVersion: string
  qualificationId: string
  rootless: true
  cgroupV2: true
  filesystemBounded: true
  descendantContainment: true
  network: 'none'
  cpuLimit: number
  memoryBytes: number
  pidsLimit: number
  diskBytes: number
}
export interface JobLaunchPlan {
  identity: string
  execution: JobExecution
  privateRepositoryRoot: string
  cwd: string
  argv: readonly string[]
  environment: Readonly<Record<string, string>>
  stdin: 'closed'
  pty: false
  profile: QualifiedJobProfile
}
export interface JobExitEvidence { exitCode: number | null; signal: string | null; execError?: string; timedOut?: boolean }
export interface JobSupervisedProcess {
  containerId?: string
  stdout: AsyncIterable<Uint8Array>
  stderr: AsyncIterable<Uint8Array>
  exited: Promise<JobExitEvidence>
  /** Includes all descendants, using runtime identity rather than an unverified PID. */
  stop(graceMs: number): Promise<boolean>
  proveStopped(): Promise<boolean>
}
export interface JobSupervisor {
  qualifiedProfile: QualifiedJobProfile | null
  launch(plan: JobLaunchPlan): Promise<JobSupervisedProcess>
}
export interface JobExecutorPorts {
  authority: JobLaunchAuthority
  source: JobSourcePort
  supervisor: JobSupervisor
  /** Resolves only after the bounded W08 worker spool has durably accepted the chunk. */
  appendLog(chunk: { executionId: string; attemptId: string; sequence: number; stream: 'stdout' | 'stderr'; text: string; byteSize: number; createdAt: string }): Promise<void>
  collectOutputs(execution: JobExecution): Promise<void>
}
export interface JobExecutorResult {
  outcome: 'succeeded' | 'build_failed' | 'spawn_failed' | 'preparation_failed' | 'cancelled' | 'timed_out' | null
  exitCode: number | null
  signal: string | null
  processStopped: boolean
  supervisorIdentity: string
  containerId: string | null
  recoveryRequired: boolean
  logError: boolean
  logsTruncated: boolean
  outputCollectionError: boolean
}

export function jobSupervisorIdentity(execution: JobExecution): string {
  return `graphql-job-${createHash('sha256').update(JSON.stringify([execution.id, execution.attemptId, execution.operationId, execution.owner, execution.acceptedSpec.specDigest])).digest('hex')}`
}

function requireProfile(spec: AcceptedJobSpec, profile: QualifiedJobProfile | null): QualifiedJobProfile {
  if (!profile || !profile.qualificationId || !profile.runtimeVersion || !profile.ociRuntimeVersion || !profile.kernelVersion ||
    profile.policyId !== spec.policy.isolationPolicyId || profile.policyRevision !== spec.policy.isolationPolicyRevision ||
    profile.imageDigest !== spec.policy.imageDigest || profile.toolchainDigest !== spec.policy.toolchainDigest ||
    profile.rootless !== true || profile.cgroupV2 !== true || profile.filesystemBounded !== true || profile.descendantContainment !== true ||
    profile.network !== 'none' || spec.policy.network !== 'none' || spec.policy.environmentScopeRefs.length > 0 || spec.policy.maxLogChunkBytes < 4 || spec.policy.maxWorkerSpoolBytes < 8 ||
    [spec.policy.preparationTimeoutMs, spec.policy.executionTimeoutMs, spec.policy.cancellationGraceMs].some(value => value > 2147423647) ||
    ![profile.cpuLimit, profile.memoryBytes, profile.pidsLimit, profile.diskBytes].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Qualified offline rootless isolation unavailable for the accepted policy.')
  }
  return profile
}

async function prepareWithinBudget<T>(budgetMs: number, cancellation: AbortSignal, prepare: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController()
  const onCancel = () => abort.abort()
  cancellation.addEventListener('abort', onCancel, { once: true })
  const deadline = setTimeout(() => abort.abort(), budgetMs)
  try {
    return await Promise.race([prepare(abort.signal), new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(new Error('Preparation interrupted.')), { once: true })
      if (cancellation.aborted) abort.abort()
    })])
  } finally { clearTimeout(deadline); cancellation.removeEventListener('abort', onCancel) }
}

/** Worker-local deadline and durable ownership; this is an executor, not a scheduler. */
export async function executeJob(input: JobExecution, ports: JobExecutorPorts, cancellation: AbortSignal): Promise<JobExecutorResult> {
  const execution = JobExecutionSchema.parse(input)
  const spec = AcceptedJobSpecSchema.parse(execution.acceptedSpec)
  const identity = jobSupervisorIdentity(execution)
  const result: JobExecutorResult = { outcome: null, exitCode: null, signal: null, processStopped: false,
    supervisorIdentity: identity, containerId: null, recoveryRequired: false, logError: false, logsTruncated: false, outputCollectionError: false }
  if (execution.process.phase === 'terminal') throw new Error('Terminal execution requires readback, not dispatch.')
  if (cancellation.aborted || execution.cancelRequestedAt) return { ...result, outcome: 'cancelled', processStopped: true }
  let plan: JobLaunchPlan
  try {
    plan = await prepareWithinBudget(spec.policy.preparationTimeoutMs, cancellation, async signal => {
      if (!spec.argv[0] || spec.argv.some(argument => argument.includes('\0'))) throw new Error('Executable/argv rejected.')
      if ((execution.workflow === null) !== (spec.workflowInput === null)) throw new Error('Accepted workflow input binding mismatch.')
      const preparedSpec: PreparedJobSpec = { source: spec.source, target: spec.target, argv: spec.argv, inputs: spec.inputs,
        policy: spec.policy, outputs: spec.outputs, ...(spec.relativeCwd ? { relativeCwd: spec.relativeCwd } : {}) }
      for (const [key, digest] of Object.entries(jobSpecDigests(preparedSpec, spec.workflowInput))) {
        if (spec[key as keyof ReturnType<typeof jobSpecDigests>] !== digest) throw new Error('Accepted specification digest mismatch.')
      }
      await ports.authority.recheck(execution)
      const profile = requireProfile(spec, ports.supervisor.qualifiedProfile)
      const source = await ports.source.verify(spec, signal)
      if (signal.aborted) throw new Error('Preparation interrupted.')
      if (!source.privateGit || !Number.isFinite(source.diskQuotaBytes) || source.diskQuotaBytes <= 0 || source.diskQuotaBytes > profile.diskBytes ||
        source.directoryIdentityHash !== spec.target.destination.directoryIdentityHash ||
        !source.privateRepositoryRoot.startsWith('/') || source.privateRepositoryRoot !== spec.target.destination.canonicalProjectRoot) {
        throw new Error('Accepted private source/root identity changed.')
      }
      const cwd = spec.relativeCwd ? `${source.privateRepositoryRoot}/${spec.relativeCwd}` : source.privateRepositoryRoot
      if (cwd !== spec.target.destination.canonicalCwd) throw new Error('Accepted working directory changed.')
      const prepared: JobLaunchPlan = { identity, execution, privateRepositoryRoot: source.privateRepositoryRoot, cwd, argv: spec.argv,
        environment: { HOME: '/tmp/job-home', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1' }, stdin: 'closed', pty: false, profile }
      await ports.authority.recheck(execution)
      return prepared
    })
  } catch {
    return { ...result, outcome: cancellation.aborted ? 'cancelled' : 'preparation_failed', processStopped: true }
  }
  if (cancellation.aborted) return { ...result, outcome: 'cancelled', processStopped: true }
  const claim = await ports.authority.claim(execution, identity)
  if (claim === 'cancelled') return { ...result, outcome: 'cancelled', processStopped: true }
  if (claim === 'reconcile') return { ...result, recoveryRequired: true }
  // From claim onward, lost acknowledgments and spawn failures require identity reconciliation.
  let process: JobSupervisedProcess
  try { process = await ports.supervisor.launch(plan) } catch {
    return { ...result, recoveryRequired: true }
  }
  result.containerId = process.containerId ?? null
  let reason: 'cancelled' | 'timed_out' | 'log_limit' | null = null
  let exitObserved = false
  const exited = process.exited.then(exit => { exitObserved = true; return exit })
  void exited.catch(() => {}) // Result handling below retains transport uncertainty.
  let stopPromise: Promise<boolean> | undefined
  const stop = (why: NonNullable<typeof reason>) => {
    if (exitObserved && why !== 'log_limit') return
    reason ??= why
    stopPromise ??= process.stop(spec.policy.cancellationGraceMs).catch(() => false)
  }
  const onCancel = () => stop('cancelled')
  cancellation.addEventListener('abort', onCancel, { once: true })
  const deadline = setTimeout(() => stop('timed_out'), spec.policy.executionTimeoutMs)
  if (cancellation.aborted) onCancel()
  let sequence = 0
  let bytes = 0
  // Serialize the two streams to make persisted sequence assignment authoritative.
  let sink: Promise<void> = Promise.resolve()
  const drain = async (stream: 'stdout' | 'stderr', chunks: AsyncIterable<Uint8Array>) => {
    const decoder = new StringDecoder('utf8')
    const emit = async (text: string) => {
      let part = ''
      let size = 0
      const persist = async () => {
        if (!part) return
        bytes += size
        if (bytes > Math.min(spec.policy.maxLogBytes, Math.floor(spec.policy.maxWorkerSpoolBytes / 2))) {
          result.logsTruncated = true
          if (spec.policy.logOverflow === 'stop') stop('log_limit')
        } else {
          const chunk = { executionId: execution.id, attemptId: execution.attemptId, sequence: ++sequence,
            stream, text: part, byteSize: size, createdAt: new Date().toISOString() }
          sink = sink.then(() => ports.appendLog(chunk))
          await sink
        }
        part = ''; size = 0
      }
      for (const character of text) {
        const length = Buffer.byteLength(character)
        if (size + length > spec.policy.maxLogChunkBytes) await persist()
        part += character; size += length
      }
      await persist()
    }
    try {
      for await (const chunk of chunks) {
        await emit(decoder.write(Buffer.from(chunk)))
      }
      await emit(decoder.end())
    } catch { result.logError = true; stop('log_limit') }
  }
  const drains = Promise.all([drain('stdout', process.stdout), drain('stderr', process.stderr)])
  try {
    try { await ports.authority.launched(execution, identity, process.containerId) } catch { result.recoveryRequired = true }
    const exit = await exited
    result.exitCode = exit.exitCode
    result.signal = exit.signal
    result.processStopped = stopPromise ? await stopPromise : await process.proveStopped().catch(() => false)
    if (!result.processStopped) result.processStopped = await process.stop(spec.policy.cancellationGraceMs).catch(() => false)
    await drains
    if (!result.processStopped) return { ...result, recoveryRequired: true }
    result.outcome = reason === 'cancelled' ? 'cancelled' : reason === 'timed_out' || exit.timedOut ? 'timed_out' :
      exit.execError ? 'spawn_failed' : exit.exitCode === 0 ? 'succeeded' : 'build_failed'
    try { await ports.collectOutputs(execution) } catch { result.outputCollectionError = true }
    return result
  } catch { return { ...result, recoveryRequired: true } } finally {
    clearTimeout(deadline)
    cancellation.removeEventListener('abort', onCancel)
  }
}
