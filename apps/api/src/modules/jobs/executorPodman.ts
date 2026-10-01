import { spawn } from 'node:child_process'
import type { JobExecution } from '@graphql/contracts'
import { jobSupervisorIdentity, type JobLaunchPlan, type JobSupervisor, type QualifiedJobProfile } from './executor.js'

/** No pulling, setup, host networking, home, socket or credentials are implied. */
export function podmanCreateArgv(plan: JobLaunchPlan): string[] {
  const relative = plan.cwd.slice(plan.privateRepositoryRoot.length)
  const runtimeRoot = plan.execution.acceptedSpec.target.destination.managedRuntimeRoot
  if (plan.stdin !== 'closed' || plan.pty || !plan.privateRepositoryRoot.startsWith('/') ||
    plan.privateRepositoryRoot.includes(',') || plan.privateRepositoryRoot.includes('\0') ||
    !plan.cwd.startsWith(`${plan.privateRepositoryRoot}/`) && plan.cwd !== plan.privateRepositoryRoot ||
    relative.split('/').some(component => component === '..') || !plan.argv[0] || plan.argv.some(arg => arg.includes('\0')) ||
    !runtimeRoot.startsWith('/') || runtimeRoot.includes(',') || runtimeRoot.includes('\0') || runtimeRoot === plan.privateRepositoryRoot ||
    runtimeRoot.startsWith(`${plan.privateRepositoryRoot}/`)) {
    throw new Error('Invalid noninteractive container plan.')
  }
  return ['create', '--name', plan.identity, '--pull=never', '--restart=no', '--read-only', '--read-only-tmpfs=false',
    '--image-volume=ignore', '--http-proxy=false', '--network=none', '--stop-signal=SIGTERM',
    '--label', `graphql.job.identity=${plan.identity}`, '--label', `graphql.job.spec=${plan.execution.acceptedSpec.specDigest}`,
    '--label', `graphql.job.attempt=${plan.execution.attemptId}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pid=private', '--ipc=private', '--userns=keep-id',
    '--pids-limit', String(plan.profile.pidsLimit), '--memory', String(plan.profile.memoryBytes),
    '--cpus', String(plan.profile.cpuLimit), '--memory-swap', String(plan.profile.memoryBytes),
    '--log-driver=k8s-file', '--log-opt', `max-size=${Math.floor(plan.execution.acceptedSpec.policy.maxWorkerSpoolBytes / 2)}`,
    '--log-opt', `path=${runtimeRoot}/${plan.identity}.oci.log`,
    '--mount', `type=bind,src=${plan.privateRepositoryRoot},dst=/workspace,rw`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=67108864',
    '--workdir', `/workspace${relative}`, '--unsetenv-all', '--env', 'HOME=/tmp/job-home', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env', 'LANG=C.UTF-8', '--env', 'CI=1', '--entrypoint', plan.argv[0]!,
    plan.profile.imageDigest, ...plan.argv.slice(1)]
}

/** W07 supplies the absolute qualified runtime path and nonsecret controller env. */
export function spawnPodmanCommand(executable: string, argv: string[], environment: Record<string, string>) {
  if (!executable.startsWith('/') || Object.keys(environment).some(key => !['PATH', 'XDG_RUNTIME_DIR', 'LANG'].includes(key))) {
    throw new Error('Runtime command environment must be explicitly allowlisted.')
  }
  return spawn(executable, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment })
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
