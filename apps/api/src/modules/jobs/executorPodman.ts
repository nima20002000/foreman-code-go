import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobExecution } from '@graphql/contracts'
import { jobSupervisorIdentity, type JobLaunchPlan, type JobSupervisor, type QualifiedJobProfile } from './executor.js'

export interface PodmanIsolationInput {
  identity: string
  sourceRoot: string
  runtimeRoot: string
  cwd: string
  argv: readonly string[]
  profile: Pick<QualifiedJobProfile, 'pidsLimit' | 'memoryBytes' | 'cpuLimit' | 'imageDigest'>
  spoolBytes: number
  labels: Record<string, string>
}
/** Shared by actual jobs and explicitly admitted model-free qualification. */
export function podmanIsolationCreateArgv(input: PodmanIsolationInput): string[] {
  const relative = input.cwd.slice(input.sourceRoot.length)
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(input.identity) || !input.sourceRoot.startsWith('/') ||
    input.sourceRoot.includes(',') || input.sourceRoot.includes('\0') ||
    !input.cwd.startsWith(`${input.sourceRoot}/`) && input.cwd !== input.sourceRoot ||
    relative.split('/').some(component => component === '..') || !input.argv[0] || input.argv.some(arg => arg.includes('\0')) ||
    !input.runtimeRoot.startsWith('/') || input.runtimeRoot.includes(',') || input.runtimeRoot.includes('\0') || input.runtimeRoot === input.sourceRoot ||
    input.runtimeRoot.startsWith(`${input.sourceRoot}/`) || !Number.isSafeInteger(input.spoolBytes) || input.spoolBytes < 8) {
    throw new Error('Invalid noninteractive container plan.')
  }
  return ['--remote=false', `--hooks-dir=${join(input.runtimeRoot, 'ci-empty-oci-hooks')}`, 'create', '--name', input.identity, '--pull=never', '--restart=no', '--read-only', '--read-only-tmpfs=false',
    '--image-volume=ignore', '--http-proxy=false', '--network=none', '--stop-signal=SIGTERM',
    ...Object.entries(input.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pid=private', '--ipc=private', '--cgroupns=private', '--userns=keep-id',
    '--pids-limit', String(input.profile.pidsLimit), '--memory', String(input.profile.memoryBytes),
    '--cpus', String(input.profile.cpuLimit), '--memory-swap', String(input.profile.memoryBytes),
    '--log-driver=k8s-file', '--log-opt', `max-size=${Math.floor(input.spoolBytes / 2)}`,
    '--log-opt', `path=${input.runtimeRoot}/${input.identity}.oci.log`,
    '--mount', `type=bind,src=${input.sourceRoot},dst=/workspace,rw`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=67108864',
    '--workdir', `/workspace${relative}`, '--unsetenv-all', '--env', 'HOME=/tmp/job-home', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env', 'LANG=C.UTF-8', '--env', 'CI=1', '--entrypoint', input.argv[0]!,
    input.profile.imageDigest, ...input.argv.slice(1)]
}

/** Application-owned empty hook directory inside the already approved runtime root. */
export async function ensureEmptyPodmanHooks(runtimeRoot: string) {
  if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error('Canonical runtime root required.')
  const root = await open(runtimeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await root.stat()
    if (metadata.uid !== process.getuid?.() || metadata.mode & 0o022) throw new Error('Runtime root ownership rejected.')
    const hooks = join(runtimeRoot, 'ci-empty-oci-hooks')
    await mkdir(hooks, { mode: 0o700 }).catch(error => { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error })
    const details = await stat(hooks)
    if (await realpath(hooks) !== hooks || !details.isDirectory() || details.uid !== metadata.uid || details.mode & 0o077 || (await readdir(hooks)).length) throw new Error('Empty owned hook directory required.')
    return hooks
  } finally { await root.close() }
}
/** No pulling, setup, host networking, home, socket or credentials are implied. */
export function podmanCreateArgv(plan: JobLaunchPlan): string[] {
  if (plan.stdin !== 'closed' || plan.pty) throw new Error('Noninteractive job required.')
  return podmanIsolationCreateArgv({ identity: plan.identity, sourceRoot: plan.privateRepositoryRoot,
    runtimeRoot: plan.execution.acceptedSpec.target.destination.managedRuntimeRoot, cwd: plan.cwd, argv: plan.argv,
    profile: plan.profile, spoolBytes: plan.execution.acceptedSpec.policy.maxWorkerSpoolBytes,
    labels: { 'graphql.job.identity': plan.identity, 'graphql.job.spec': plan.execution.acceptedSpec.specDigest, 'graphql.job.attempt': plan.execution.attemptId } })
}

/** W07 supplies the absolute qualified runtime path and nonsecret controller env. */
export function spawnPodmanCommand(executable: string, argv: string[], environment: Record<string, string>) {
  if (!executable.startsWith('/') || Object.keys(environment).some(key => !['PATH', 'XDG_RUNTIME_DIR', 'LANG'].includes(key))) {
    throw new Error('Runtime command environment must be explicitly allowlisted.')
  }
  return spawn(executable, argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment })
}

export interface PodmanCommandRunner {
  run(argv: string[], timeoutMs?: number): Promise<{ exitCode: number; stdout: string }>
  attach(argv: string[]): ReturnType<typeof spawnPodmanCommand>
}

/** Bounded control replies. Job logs go through the executor's bounded streaming sink. */
export function nodePodmanCommandRunner(executable: string, environment: Record<string, string>): PodmanCommandRunner {
  return { attach: argv => spawnPodmanCommand(executable, argv, environment), run: (argv, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const child = spawnPodmanCommand(executable, argv, environment)
    let stdout = ''; let bytes = 0
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime control deadline exceeded.')) }, timeoutMs)
    const capture = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length
      if (bytes > 65536) { child.kill('SIGKILL'); reject(new Error('Runtime control reply exceeded budget.')) }
      else if (output) stdout += chunk.toString('utf8')
    }
    child.stdout.on('data', chunk => capture(chunk, true))
    child.stderr.on('data', chunk => capture(chunk, false))
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', code => { clearTimeout(deadline); resolve({ exitCode: code ?? 1, stdout }) })
  }) }
}

interface ContainerEvidence { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean; Pid: number; ExitCode: number; Status: string; Error?: string } }
function evidence(stdout: string, execution: JobExecution): ContainerEvidence {
  const rows: unknown = JSON.parse(stdout)
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Container identity unavailable.')
  const row = rows[0] as ContainerEvidence
  if (!/^[a-f0-9]{64}$/.test(row.Id) || row.Config?.Labels?.['graphql.job.identity'] !== jobSupervisorIdentity(execution) ||
    row.Config.Labels['graphql.job.spec'] !== execution.acceptedSpec.specDigest || row.Config.Labels['graphql.job.attempt'] !== execution.attemptId ||
    typeof row.State?.Running !== 'boolean' || !Number.isInteger(row.State.Pid) || !Number.isInteger(row.State.ExitCode)) {
    throw new Error('Owned container evidence mismatch.')
  }
  return row
}

/** Only use with a persisted, human-approved qualification record; never probes/installs/pulls. */
export class PodmanJobSupervisor implements JobSupervisor {
  constructor(readonly qualifiedProfile: QualifiedJobProfile | null, private readonly commands: PodmanCommandRunner) {}

  async reconcile(execution: JobExecution): Promise<{ containerId: string; stopped: boolean; exitCode: number | null; logGapPossible: true } | null> {
    const reply = await this.commands.run(['container', 'inspect', jobSupervisorIdentity(execution)])
    if (reply.exitCode !== 0) return null // Missing is uncertainty, never permission to relaunch.
    const row = evidence(reply.stdout, execution)
    const stopped = !row.State.Running && row.State.Pid === 0 && row.State.Status === 'exited'
    return { containerId: row.Id, stopped, exitCode: stopped ? row.State.ExitCode : null, logGapPossible: true }
  }

  /** W08 recovery/control uses original execution scope, including after worker restart. */
  async stopExecution(execution: JobExecution, graceMs: number, expectedContainerId?: string): Promise<boolean> {
    const recovered = await this.reconcile(execution)
    if (!recovered || expectedContainerId && recovered.containerId !== expectedContainerId) return false
    const containerId = recovered.containerId
    const inspect = async () => {
      const reply = await this.commands.run(['container', 'inspect', containerId])
      if (reply.exitCode !== 0) throw new Error('Container inspection unavailable.')
      const row = evidence(reply.stdout, execution)
      if (row.Id !== containerId) throw new Error('Container ID changed.')
      return row
    }
    const stopped = (row: ContainerEvidence) => !row.State.Running && row.State.Pid === 0 && row.State.Status === 'exited'
    if (stopped(await inspect())) return true
    try { await this.commands.run(['stop', '--time', String(Math.ceil(graceMs / 1000)), containerId], graceMs + 30000) } catch { /* Reinspect a lost stop reply before escalation. */ }
    if (stopped(await inspect())) return true
    await inspect()
    try { await this.commands.run(['kill', '--signal', 'KILL', containerId]) } catch { /* Only inspection establishes closure. */ }
    return stopped(await inspect())
  }

  async launch(plan: JobLaunchPlan) {
    if (!this.qualifiedProfile || plan.profile !== this.qualifiedProfile) throw new Error('Qualified isolation unavailable.')
    await ensureEmptyPodmanHooks(plan.execution.acceptedSpec.target.destination.managedRuntimeRoot)
    const created = await this.commands.run(podmanCreateArgv(plan), plan.execution.acceptedSpec.policy.preparationTimeoutMs)
    const containerId = created.stdout.trim()
    if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Container create uncertain; reconcile original identity.')
    const inspect = async () => {
      const reply = await this.commands.run(['container', 'inspect', containerId])
      if (reply.exitCode !== 0) throw new Error('Container inspection unavailable.')
      const row = evidence(reply.stdout, plan.execution)
      if (row.Id !== containerId) throw new Error('Container ID changed.')
      return row
    }
    await inspect()
    // Attachment carries only output; controller lifetime is provided by the W07 durable worker service.
    const attached = this.commands.attach(['start', '--attach', '--sig-proxy=false', containerId])
    attached.once('error', error => attached.stdout.destroy(error))
    const proveStopped = async () => {
      const row = await inspect()
      return !row.State.Running && row.State.Pid === 0 && row.State.Status === 'exited'
    }
    const stop = async (graceMs: number) => {
      const stopped = await this.stopExecution(plan.execution, graceMs, containerId)
      if (stopped) clearTimeout(deadline)
      return stopped
    }
    // Independent of attachment and main connectivity; uncertainty cannot clear this watchdog.
    let deadlineFired = false
    const deadline = setTimeout(() => { deadlineFired = true; void stop(plan.execution.acceptedSpec.policy.cancellationGraceMs).catch(() => {}) }, plan.execution.acceptedSpec.policy.executionTimeoutMs)
    deadline.unref()
    const exited = this.commands.run(['wait', '--condition=exited', containerId], plan.execution.acceptedSpec.policy.executionTimeoutMs + plan.execution.acceptedSpec.policy.cancellationGraceMs + 30000).then(async waited => {
      const row = await inspect()
      if (row.State.Running || row.State.Pid !== 0 || row.State.Status !== 'exited') throw new Error('Wait ended without stopped container proof.')
      clearTimeout(deadline)
      if (waited.exitCode !== 0 || Number(waited.stdout.trim()) !== row.State.ExitCode) throw new Error('Container wait evidence mismatch.')
      return { exitCode: row.State.ExitCode, signal: null, ...(deadlineFired ? { timedOut: true } : {}), ...(row.State.Error ? { execError: 'Container command launch failed.' } : {}) }
    })
    void exited.catch(() => {})
    return { containerId, stdout: attached.stdout, stderr: attached.stderr, exited, proveStopped, stop }
  }
}
