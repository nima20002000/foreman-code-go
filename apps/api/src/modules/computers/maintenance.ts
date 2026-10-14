import { errorMessage } from '../../shared/errorMessage.js'
import { readOperationalFailures } from '../diagnostics/logger.js'
import { readClaudePlugins, claudeCliResult } from './claudePlugins.js'
import { isCodexStagingRenameError, removeCodexStagingDirectories } from './npmStaging.js'
import { syncFingerprint } from './syncFingerprint.js'
import { MaintenanceTaskStore } from './maintenanceTaskStore.js'
import { MaintenanceCommandStore } from './maintenanceCommandStore.js'
import type { MaintenancePorts } from './maintenancePorts.js'
import { DomainError } from '../errors.js'
import { executableUnavailable } from './executableError.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import {
  MaintenanceStatusSchema, MaintenanceTaskSchema, MaintenanceTaskStartSchema,
  type MaintainedHarness, type MaintenanceStatus, type MaintenanceTask,
  type MaintenanceTaskStart, type SyncedMarketplace, type SyncedMcpServer,
  type WorkerUpdateStatus,
} from '@foreman-code/contracts/computer-maintenance'

export type { MaintenancePorts }

type FleetLedger = { mcp: Record<MaintainedHarness, string[]>; codexPlugins: string[]; claudePlugins: string[] }
const PACKAGES: Record<MaintainedHarness, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' }
const LABELS: Record<MaintainedHarness, string> = { codex: 'Codex', claude: 'Claude' }
const LATEST_MS = 60 * 60_000
const LONG_MS = 20 * 60_000
const APT = ['env', 'LC_ALL=C', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=a', 'apt-get', '-y', '-q',
  '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']

function tail(text: string, limit = 8000) { return text.length > limit ? text.slice(-limit) : text }
type Step = (binary: string, args: string[], label: string, options?: { timeoutMs?: number; allowFailure?: boolean })
  => Promise<{ code: number | null; stdout: string; stderr: string }>
function versionOf(output: string): string | null {
  return output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/u)?.[0] ?? null
}

function maintenanceError(error: unknown, fallback: string): string {
  const details = error as NodeJS.ErrnoException | null
  const message = errorMessage(error, fallback)
  if (details?.code === 'EDQUOT' || details?.errno === -122 || message.includes('Unknown system error -122')) {
    return 'Disk quota reached on this computer. Free space or increase its disk quota, then retry maintenance.'
  }
  if (details?.code === 'ENOSPC' || details?.errno === -28) {
    return 'This computer is out of disk space. Free space, then retry maintenance.'
  }
  return message
}

function meetsPublishedVersion(installed: string, published: string): boolean {
  if (installed === published) return true
  const stableVersion = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/u
  const actual = installed.match(stableVersion)
  const expected = published.match(stableVersion)
  if (!actual || !expected) return false
  for (let index = 1; index <= 3; index++) {
    const difference = Number(actual[index]) - Number(expected[index])
    if (difference !== 0) return difference > 0
  }
  return true
}

/**
 * Keeps this computer's harnesses, packages, MCP servers and Codex plugins current. Runs on Main for itself and on every
 * paired computer for Main's requests. Long work runs as background tasks that status readback reports.
 */
export class ComputerMaintenance {
  private readonly tasks: MaintenanceTask[] = []
  private readonly activeTasks = new Map<string, { requestHash: string; completion: Promise<void> }>()
  private taskRevision = 0
  private readonly taskStore: MaintenanceTaskStore
  private readonly commandStore: MaintenanceCommandStore
  private readonly taskCommands = new Map<string, Map<string, string>>()
  private admissions: Promise<unknown> = Promise.resolve()
  private closing = false
  private loadedTasks: Promise<void> | undefined
  private storageFailure: unknown
  private latest: { at: number; value: Promise<Partial<Record<MaintainedHarness, string | null>>> } | undefined
  constructor(private readonly ports: MaintenancePorts = systemMaintenancePorts()) {
    const home = ports.environment.HOME ?? homedir()
    this.taskStore = new MaintenanceTaskStore(join(home, '.local', 'state', 'foreman-code', 'maintenance-tasks.json'), ports)
    this.commandStore = new MaintenanceCommandStore(join(home, '.local', 'state', 'foreman-code', 'maintenance-commands'), ports)
  }

  private async loadTasks(): Promise<void> {
    this.loadedTasks ??= this.taskStore.load().then(tasks => { this.tasks.push(...tasks) })
    await this.loadedTasks
    await this.taskStore.flushed()
    await this.commandStore.flushed()
    if (this.storageFailure) throw this.storageFailure
  }

  async status(signal: AbortSignal): Promise<MaintenanceStatus> {
    await this.loadTasks()
    for (;;) {
      signal.throwIfAborted()
      const revision = this.taskRevision
      const status = await this.observe(signal)
      await this.taskStore.flushed()
      if (revision === this.taskRevision) return status
    }
  }

  private async observe(signal: AbortSignal): Promise<MaintenanceStatus> {
    const worker = await this.ports.workerUpdate?.status()
    if (worker) {
      for (const task of this.tasks.filter(task => task.kind === 'update-worker' && task.state === 'running')) {
        const outcome = await this.workerTaskOutcome(task, worker)
        if (!outcome) continue
        await this.finish(task, outcome.state === 'current' ? 'succeeded' : 'failed',
          outcome.lastError ?? `Worker ${outcome.currentVersion} is current.`)
      }
    }
    const home = this.ports.environment.HOME ?? homedir()
    const [versions, latest, packageUpdates, rebootRequired, sudo, disk] = await Promise.all([
      Promise.all((['codex', 'claude'] as const).map(harness => this.installedVersion(harness, signal))),
      this.latestVersions(signal),
      this.packageUpdates(signal),
      this.ports.exists('/var/run/reboot-required'),
      this.sudo(signal),
      this.ports.disk(home).then(value => value && { path: home, ...value }),
    ])
    return MaintenanceStatusSchema.parse({
      operationalFailures: readOperationalFailures(),
      harnesses: (['codex', 'claude'] as const).map((harness, index) => ({ harness, installed: versions[index] !== undefined,
        version: versions[index] ?? null, latest: latest[harness] ?? null })),
      system: { packageUpdates: packageUpdates?.pending ?? null, rebootRequired, sudo, disk },
      tasks: [...this.tasks].reverse(), observedAt: this.ports.now().toISOString(),
      ...(worker ? { worker } : {}),
    })
  }

  private async workerTaskOutcome(task: MaintenanceTask, worker: WorkerUpdateStatus) {
    if (task.workerTargetVersion === undefined) return null
    const retained = await this.ports.workerUpdate?.outcome?.(task)
    if (retained) return retained
    const matching = worker.state === 'current' ? worker.currentVersion === task.workerTargetVersion
      : worker.targetVersion === task.workerTargetVersion
    return matching && ['current', 'failed', 'rolled-back'].includes(worker.state) ? worker : null
  }

  /** Saves the task before acknowledgement; status readback follows its background progress. */
  async start(raw: MaintenanceTaskStart, commandId: string = randomUUID()): Promise<MaintenanceTask> {
    this.assertOpen()
    const id = z.uuid().parse(commandId)
    const request = MaintenanceTaskStartSchema.parse(raw)
    const admission = this.admissions.then(() => this.admit(request, id))
    // A rejected request does not prevent a later independent command from being admitted.
    this.admissions = admission.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ })
    return admission
  }

  async drain(): Promise<void> {
    await this.admissions
    await Promise.all([...this.activeTasks.values()].map(task => task.completion))
    await this.loadTasks()
  }

  stopAdmission(): void {
    this.closing = true
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new DomainError('COMPUTER_MAINTENANCE_CLOSING', 'Computer maintenance is shutting down.', 503)
    }
  }

  async drainForWorkerUpdate(): Promise<void> {
    await this.admissions
    const tasks = this.tasks.filter(task => task.kind !== 'update-worker')
    await Promise.all(tasks.flatMap(task => {
      const active = this.activeTasks.get(task.id)
      return active ? [active.completion] : []
    }))
    await this.loadTasks()
  }

  private async admit(request: MaintenanceTaskStart, commandId: string): Promise<MaintenanceTask> {
    await this.loadTasks()
    const identity = request.kind === 'update-harnesses'
      ? { ...request, harnesses: [...request.harnesses].sort() } : request
    const requestHash = commandInputHash(identity)
    const receipt = await this.commandStore.read(commandId)
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
      }
      const retained = this.tasks.find(task => task.id === receipt.task.id) ?? receipt.task
      if (retained.kind === 'update-worker' && retained.state === 'running') {
        const worker = await this.ports.workerUpdate?.status()
        const outcome = worker ? await this.workerTaskOutcome(retained, worker) : null
        if (outcome) {
          await this.finish(retained, outcome.state === 'current' ? 'succeeded' : 'failed',
            outcome.lastError ?? `Worker ${outcome.currentVersion} is current.`)
        }
      }
      if (retained.kind !== 'update-worker' && retained.state === 'running' && !this.activeTasks.has(retained.id)) {
        retained.state = 'failed'
        retained.summary = 'Maintenance was interrupted when the application stopped. Check its status before retrying.'
        retained.finishedAt = this.ports.now().toISOString()
      }
      await this.commandStore.save(commandId, requestHash, retained)
      return structuredClone(retained)
    }
    this.assertOpen()
    const previous = this.tasks.findLast(task => task.state === 'running' && task.kind === request.kind)
    if (previous && this.activeTasks.get(previous.id)?.requestHash === requestHash) {
      await this.taskStore.flushed()
      await this.bindCommand(commandId, requestHash, previous)
      return structuredClone(previous)
    }
    if (this.tasks.length === 20) {
      const oldestFinished = this.tasks.findIndex(task => task.state !== 'running')
      if (oldestFinished < 0) throw new Error('The maintenance queue is full. Wait for a task to finish before retrying.')
      this.tasks.splice(oldestFinished, 1)
    }
    const task: MaintenanceTask = { id: commandId, kind: request.kind, state: 'running',
      startedAt: this.ports.now().toISOString(), finishedAt: null,
      summary: previous ? 'Waiting for the previous task…' : 'Running…', outputTail: '' }
    if (request.kind === 'sync-mcp' || request.kind === 'sync-plugins') task.sourceFingerprint = syncFingerprint(request)
    await this.bindCommand(commandId, requestHash, task)
    this.tasks.push(task)
    this.taskRevision++
    const saved = this.taskStore.save(this.tasks)
    const predecessor = previous ? this.activeTasks.get(previous.id)?.completion : undefined
    const completion = saved.then(async () => {
      await predecessor
      task.summary = 'Running…'
      return this.perform(request, task)
    }).then(async summary => {
      if (request.kind === 'update-worker') {
        const worker = await this.ports.workerUpdate?.status()
        if (worker?.state === 'restarting' && worker.targetVersion) {
          task.workerTargetVersion = worker.targetVersion
          task.summary = summary
          this.taskRevision++
          await this.taskStore.save(this.tasks)
          return
        }
        if (worker && ['failed', 'rolled-back'].includes(worker.state)) {
          await this.finish(task, 'failed', worker.lastError ?? 'Worker update failed.')
          return
        }
      }
      await this.finish(task, 'succeeded', summary)
    },
      (error: unknown) => this.finish(task, 'failed', maintenanceError(error, 'Maintenance failed.')))
      .catch((error: unknown) => { this.storageFailure = new Error(maintenanceError(error, 'Maintenance storage failed.')) })
    this.activeTasks.set(task.id, { requestHash, completion })
    await saved
    return MaintenanceTaskSchema.parse(structuredClone(task))
  }

  private async bindCommand(commandId: string, requestHash: string, task: MaintenanceTask): Promise<void> {
    let commands = this.taskCommands.get(task.id)
    if (!commands) {
      commands = new Map()
      this.taskCommands.set(task.id, commands)
    }
    commands.set(commandId, requestHash)
    await this.commandStore.save(commandId, requestHash, task)
  }

  /** Which MCP servers and plugins this computer last received from Main, so a later sync can remove the ones Main
   * no longer has without touching anything the computer has on its own. */
  private ledgerPath() { return join(this.ports.environment.HOME ?? homedir(), '.local', 'state', 'foreman-code', 'fleet-sync.json') }
  private async readLedger(): Promise<FleetLedger> {
    const empty: FleetLedger = { mcp: { codex: [], claude: [] }, codexPlugins: [], claudePlugins: [] }
    const text = await this.ports.readText(this.ledgerPath())
    if (!text) return empty
    try {
      const value = JSON.parse(text) as Partial<FleetLedger>
      const names = (input: unknown) => Array.isArray(input) ? input.filter((name): name is string => typeof name === 'string') : []
      return { mcp: { codex: names(value.mcp?.codex), claude: names(value.mcp?.claude) },
        codexPlugins: names(value.codexPlugins), claudePlugins: names(value.claudePlugins) }
    } catch { return empty }
  }
  private ledgerWrites: Promise<unknown> = Promise.resolve()
  /** MCP and plugin syncs can run at once; each changes only its own part of the ledger, one write at a time. */
  private updateLedger(change: (ledger: FleetLedger) => void): Promise<void> {
    const write = this.ledgerWrites.then(async () => {
      const ledger = await this.readLedger()
      change(ledger)
      await this.ports.writePrivateText(this.ledgerPath(), `${JSON.stringify(ledger)}\n`)
    })
    this.ledgerWrites = write.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ })
    return write
  }

  private async finish(task: MaintenanceTask, state: 'succeeded' | 'failed', summary: string) {
    task.state = state
    task.summary = summary.slice(0, 2000)
    task.finishedAt = this.ports.now().toISOString()
    this.taskRevision++
    await this.taskStore.save(this.tasks)
    for (const [commandId, requestHash] of this.taskCommands.get(task.id) ?? []) {
      await this.commandStore.save(commandId, requestHash, task)
    }
    this.taskCommands.delete(task.id)
    this.activeTasks.delete(task.id)
  }

  private async perform(request: MaintenanceTaskStart, task: MaintenanceTask): Promise<string> {
    const signal = AbortSignal.timeout(LONG_MS)
    const step: Step = async (binary, args, label, options = {}) => {
      const result = await this.ports.run(binary, args, { signal, timeoutMs: options.timeoutMs ?? LONG_MS })
      task.outputTail = tail(`${task.outputTail}\n$ ${label}\n${result.stdout}${result.stderr}`)
      if (result.code !== 0 && !options.allowFailure) throw new Error(`${label} failed${result.code === null ? '' : ` (exit ${result.code})`}.`)
      return result
    }
    switch (request.kind) {
      case 'update-worker': {
        if (!this.ports.workerUpdate) {
          throw new DomainError('WORKER_UPDATE_UNAVAILABLE',
            'Worker updates are available only on paired computers with an installed updater.', 409)
        }
        return this.ports.workerUpdate.start()
      }
      case 'update-harnesses': {
        const changes: string[] = []
        const failures: string[] = []
        this.latest = undefined
        const latest = await this.latestVersions(signal)
        // Each harness is updated and verified on its own, so one failure does not hide the other's result.
        for (const harness of request.harnesses) {
          try {
            const before = await this.installedVersion(harness, signal)
            await this.installLatest(harness, step)
            if (harness === 'codex' && this.ports.selectInstalledCodex) {
              const selected = await this.ports.selectInstalledCodex(signal)
              if (selected) task.outputTail = tail(`${task.outputTail}\nSelected ${selected} for this computer's Codex.`)
            }
            const after = await this.installedVersion(harness, signal)
            if (!after || !latest[harness]) throw new Error(`${LABELS[harness]} update could not be verified.`)
            if (!meetsPublishedVersion(after, latest[harness])) {
              throw new Error(`${LABELS[harness]} is still ${after}; latest published version is ${latest[harness]}.`)
            }
            changes.push(`${LABELS[harness]} ${before ?? 'not installed'} → ${after}`)
          } catch (error) {
            failures.push(maintenanceError(error, `${LABELS[harness]} update failed.`))
          }
        }
        this.latest = undefined
        if (failures.length) throw new Error([...changes, ...failures].join(' · '))
        return changes.join(' · ')
      }
      case 'update-system': {
        await this.requireSudo(signal)
        await step('sudo', ['-n', ...APT, 'update'], 'apt-get update')
        const upgrade = await step('sudo', ['-n', ...APT, '--with-new-pkgs', 'upgrade'], 'apt-get upgrade --with-new-pkgs')
        const upgraded = upgrade.stdout.match(/(\d+) upgraded/u)?.[1]
        if (!upgraded) throw new Error('The package upgrade result could not be read; check pending updates before retrying.')
        const remaining = await this.packageUpdates(signal)
        if (!remaining) throw new Error(`${upgraded} packages upgraded, but remaining updates could not be verified.`)
        if (remaining.installable > 0) {
          throw new Error(`${upgraded} packages upgraded; ${remaining.installable} installable updates remain.`)
        }
        const reboot = await this.ports.exists('/var/run/reboot-required')
        const pending = remaining.pending ? ` · ${remaining.pending} updates pending (deferred or held by APT)` : ' · no pending updates'
        return `${upgraded} packages upgraded${pending}${reboot ? ' · restart needed' : ''}`
      }
      case 'restart': {
        await this.requireSudo(signal)
        task.summary = 'Restart scheduled in a few seconds.'
        await this.taskStore.save(this.tasks)
        await new Promise<void>(resolve => { this.ports.later(resolve, 3_000) })
        await step('sudo', ['-n', 'systemctl', 'reboot'], 'Restart command', { timeoutMs: 60_000 })
        return 'Restart command accepted. Waiting for this computer to reconnect.'
      }
      case 'sync-mcp': {
        const ledger = await this.readLedger()
        const results: string[] = [...request.warnings ?? []]
        const failures: string[] = []
        for (const harness of ['codex', 'claude'] as const) {
          const servers = request.servers[harness]
          if (servers === undefined) continue
          const managed = new Set(ledger.mcp[harness])
          try {
            const summary = await this.syncMcp(harness, servers, managed, step, signal,
              request.skippedServers?.[harness] ?? [],
              () => this.updateLedger(current => { current.mcp[harness] = [...managed] }))
            if (summary) results.push(`${LABELS[harness]}: ${summary}`)
          } catch (error) {
            failures.push(maintenanceError(error, `${LABELS[harness]} MCP sync failed.`))
          } finally {
            await this.updateLedger(current => { current.mcp[harness] = [...managed] })
          }
        }
        if (failures.length) throw new Error([...failures, ...results].join(' · '))
        return results.join(' · ') || 'Nothing to sync'
      }
      case 'sync-plugins': {
        const ledger = await this.readLedger()
        const results: string[] = [...request.warnings ?? []]
        const failures: string[] = []
        const sync = [
          { name: 'Codex', run: async () => {
            if (request.plugins === undefined || request.marketplaces === undefined) return 'Skipped'
            const managed = new Set(ledger.codexPlugins)
            try {
              return await this.syncPlugins(request.plugins, request.marketplaces, managed, step, signal,
                () => this.updateLedger(current => { current.codexPlugins = [...managed] }))
            } finally {
              await this.updateLedger(current => { current.codexPlugins = [...managed] })
            }
          } },
          { name: 'Claude', run: async () => {
            if (request.claudePlugins === undefined || request.claudeMarketplaces === undefined) return 'Skipped'
            const managed = new Set(ledger.claudePlugins)
            try {
              return await this.syncClaudePlugins(request.claudePlugins, request.claudeMarketplaces, managed, step, signal,
                () => this.updateLedger(current => { current.claudePlugins = [...managed] }))
            } finally {
              await this.updateLedger(current => { current.claudePlugins = [...managed] })
            }
          } },
        ]
        for (const harness of sync) {
          try { results.push(`${harness.name}: ${await harness.run()}`) }
          catch (error) { failures.push(`${harness.name}: ${maintenanceError(error, 'Plugin sync failed.')}`) }
        }
        if (failures.length) throw new Error([...failures, ...results].join(' · '))
        return results.join(' · ')
      }
    }
  }

  private async installLatest(harness: MaintainedHarness, step: Step) {
    const home = this.ports.environment.HOME ?? homedir()
    if (harness === 'claude') {
      const claude = await this.ports.find('claude')
      // The native Claude build updates itself; a missing one uses the official installer.
      if (claude) { await step(claude, ['update'], 'claude update'); return }
      await step('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], 'Claude installer')
      return
    }
    const npm = await this.ports.find('npm')
    if (!npm) throw new Error('npm is not installed on this computer, so Codex cannot be installed.')
    const args = ['install', '--global', '--include=optional', '--prefix', join(home, '.local'),
      `${PACKAGES.codex}@latest`]
    const label = 'npm install @openai/codex@latest'
    const result = await step(npm, args, label, { allowFailure: true })
    if (result.code === 0) return
    const scope = join(home, '.local', 'lib', 'node_modules', '@openai')
    if (!isCodexStagingRenameError(`${result.stdout}\n${result.stderr}`, scope)) {
      throw new Error(`${label} failed${result.code === null ? '' : ` (exit ${result.code})`}.`)
    }
    try {
      await removeCodexStagingDirectories(scope)
    } catch (error) {
      throw new Error(`Codex update could not clean stale npm staging directories: ${maintenanceError(error,
        'Cleanup failed.')} Check the user-owned @openai/.codex-* directories before retrying.`, { cause: error })
    }
    const retried = await step(npm, args, `${label} (retry after stale npm staging cleanup)`, { allowFailure: true })
    if (retried.code !== 0) {
      throw new Error('Codex update failed after stale npm staging cleanup and one retry. '
        + 'Check the maintenance output and the user-owned @openai/.codex-* directories before retrying.')
    }
  }

  /** Adds Main's servers this computer lacks and removes the ones it received from Main earlier that Main has since
   * removed. Servers the computer has on its own are never touched. */
  private async syncMcp(harness: MaintainedHarness, servers: readonly SyncedMcpServer[], managed: Set<string>, step: Step,
    signal: AbortSignal, skipped: readonly string[], saveOwnership: () => Promise<void>): Promise<string> {
    const previous = [...managed]
    const wanted = new Set([...servers.map(server => server.name), ...skipped])
    const binary = await this.ports.find(harness)
    if (!binary) {
      if (servers.length || previous.length) throw new Error(`${LABELS[harness]} is not installed; MCP sync remains pending.`)
      return ''
    }
    if (!servers.length && !previous.length) return ''
    const existing = new Set(await this.mcpNames(harness, binary, signal))
    const added: string[] = []
    const removed: string[] = []
    const kept: string[] = []
    for (const name of previous) {
      if (wanted.has(name)) continue
      if (!existing.has(name)) {
        managed.delete(name)
        continue
      }
      const result = await step(binary, harness === 'codex' ? ['mcp', 'remove', name] : ['mcp', 'remove', '--scope', 'user', name],
        `${harness} mcp remove ${name}`, { timeoutMs: 30_000, allowFailure: true })
      if (result.code === 0) {
        removed.push(name)
        managed.delete(name)
      } else kept.push(name)
    }
    for (const server of servers) {
      if (existing.has(server.name)) continue
      // Reserve only absent native entries before installation so interruption preserves ownership.
      managed.add(server.name)
      await saveOwnership()
      if (harness === 'codex') {
        const label = `codex mcp add ${server.name}`
        // Codex saves the server, then waits for a browser sign-in on OAuth servers. That sign-in
        // belongs to the person at that computer, so a saved server counts as added.
        const result = await step(binary, server.transport === 'http'
          ? ['mcp', 'add', server.name, '--url', server.url, ...(server.bearerTokenEnvVar ? ['--bearer-token-env-var', server.bearerTokenEnvVar] : [])]
          : ['mcp', 'add', server.name, '--', server.command, ...server.args], label, { timeoutMs: 30_000, allowFailure: true })
        if (result.code !== 0) {
          if (!(await this.mcpNames(harness, binary, signal)).includes(server.name)) throw new Error(`${label} failed.`)
          managed.add(server.name)
          added.push(`${server.name} (sign in on this computer)`)
          continue
        }
      } else {
        const definition = server.transport === 'http' ? { type: 'http', url: server.url } : { type: 'stdio', command: server.command, args: server.args }
        await step(binary, ['mcp', 'add-json', '--scope', 'user', server.name, JSON.stringify(definition)], `claude mcp add-json ${server.name}`)
      }
      managed.add(server.name)
      added.push(server.name)
    }
    // A server that could not be removed stays managed, so the next sync tries again.
    if (kept.length) throw new Error(`Could not remove ${kept.join(', ')}`)
    const summary = [added.length ? `Added ${added.join(', ')}` : '', removed.length ? `Removed ${removed.join(', ')}` : '']
      .filter(Boolean).join(' · ')
    return summary || 'Already in sync'
  }

  private async mcpNames(harness: MaintainedHarness, binary: string, signal: AbortSignal): Promise<string[]> {
    if (harness === 'codex') {
      const listed = await this.ports.run(binary, ['mcp', 'list', '--json'], { signal, timeoutMs: 60_000 })
      if (listed.code !== 0) {
        throw new Error('Codex could not list its MCP servers. Update or reinstall Codex on this computer, then retry sync.')
      }
      return (JSON.parse(listed.stdout) as { name?: unknown }[]).flatMap(entry => typeof entry.name === 'string' ? [entry.name] : [])
    }
    return Object.keys(await claudeUserMcpServers(this.ports))
  }

  private async syncPlugins(plugins: readonly string[], marketplaces: readonly SyncedMarketplace[], managed: Set<string>,
    step: Step, signal: AbortSignal, saveOwnership: () => Promise<void>): Promise<string> {
    const previous = [...managed]
    if (!plugins.length && !previous.length) return 'Nothing to sync'
    const codex = await this.ports.find('codex')
    if (!codex) throw new Error('Codex is not installed on this computer.')
    const installed = new Set(await installedPlugins(this.ports, codex, signal))
    const missing = plugins.filter(plugin => !installed.has(plugin))
    const known = new Set(missing.length ? (await pluginMarketplaces(this.ports, codex, signal)).map(marketplace => marketplace.name) : [])
    const added: string[] = []
    const failed: string[] = []
    const removed: string[] = []
    const kept: string[] = []
    for (const plugin of previous) {
      if (plugins.includes(plugin)) continue
      if (!installed.has(plugin)) {
        managed.delete(plugin)
        continue
      }
      const result = await step(codex, ['plugin', 'remove', plugin], `codex plugin remove ${plugin}`, { allowFailure: true })
      if (result.code === 0) {
        removed.push(plugin)
        managed.delete(plugin)
      } else kept.push(plugin)
    }
    for (const marketplace of marketplaces) {
      if (known.has(marketplace.name) || !missing.some(plugin => plugin.endsWith(`@${marketplace.name}`))) continue
      const result = await step(codex, ['plugin', 'marketplace', 'add', marketplace.source], `codex plugin marketplace add ${marketplace.source}`, { allowFailure: true })
      if (result.code === 0) known.add(marketplace.name)
    }
    // One plugin that cannot install does not keep the others from installing.
    for (const plugin of missing) {
      managed.add(plugin)
      await saveOwnership()
      const result = await step(codex, ['plugin', 'add', plugin], `codex plugin add ${plugin}`, { allowFailure: true })
      if (result.code === 0) {
        added.push(plugin)
        managed.add(plugin)
      } else failed.push(plugin)
    }
    const summary = [added.length ? `Installed ${added.join(', ')}` : '', removed.length ? `Removed ${removed.join(', ')}` : '',
      failed.length ? `Could not install ${failed.join(', ')}` : '', kept.length ? `Could not remove ${kept.join(', ')}` : '']
      .filter(Boolean).join(' · ')
    if (failed.length || kept.length) throw new Error(summary)
    return summary || 'Already in sync'
  }

  private async syncClaudePlugins(
    plugins: readonly { pluginId: string; enabled: boolean }[], marketplaces: readonly SyncedMarketplace[],
    managed: Set<string>, step: Step, signal: AbortSignal, saveOwnership: () => Promise<void>,
  ): Promise<string> {
    const previous = [...managed]
    const wanted = plugins.map(plugin => plugin.pluginId)
    if (!wanted.length && !previous.length) return 'Nothing to sync'
    const claude = await this.ports.find('claude')
    if (!claude) throw new Error('Claude Code is not installed on this computer.')
    const catalog = await readClaudePlugins(this.ports, signal)
    const installed = new Map(catalog.plugins.filter(item => item.installed).map(item => [item.pluginId, item]))
    const known = new Set(catalog.marketplaces.map(item => item.name))
    const failed: string[] = []
    const removed: string[] = []
    const kept: string[] = []
    for (const pluginId of previous) {
      if (wanted.includes(pluginId)) continue
      if (!installed.has(pluginId)) {
        managed.delete(pluginId)
        continue
      }
      const result = await step(claude, ['plugin', 'uninstall', pluginId, '--scope', 'user', '--json'],
        `claude plugin uninstall ${pluginId}`, { allowFailure: true })
      ;(result.code === 0 && claudeCliResult(result.stdout)?.outcome === 'ok' ? removed : kept).push(pluginId)
    }
    for (const marketplace of marketplaces) {
      if (known.has(marketplace.name)) continue
      const result = await step(claude, ['plugin', 'marketplace', 'add', marketplace.source, '--json'],
        `claude plugin marketplace add ${marketplace.source}`, { allowFailure: true })
      if (result.code === 0 && claudeCliResult(result.stdout)?.outcome === 'ok') known.add(marketplace.name)
      else failed.push(`marketplace ${marketplace.name}`)
    }
    for (const plugin of plugins) {
      const existing = installed.get(plugin.pluginId)
      if (existing && !managed.has(plugin.pluginId)) continue
      const actions: string[] = []
      if (!existing) actions.push('install')
      if (!plugin.enabled) actions.push('disable')
      else if (existing && !existing.enabled) actions.push('enable')
      for (const action of actions) {
        if (action === 'install') {
          managed.add(plugin.pluginId)
          await saveOwnership()
        }
        const result = await step(claude, ['plugin', action, plugin.pluginId, '--scope', 'user', '--json'],
          `claude plugin ${action} ${plugin.pluginId}`, { allowFailure: true })
        if (result.code !== 0 || claudeCliResult(result.stdout)?.outcome !== 'ok') {
          failed.push(plugin.pluginId)
          break
        }
        if (action === 'install') managed.add(plugin.pluginId)
      }
    }
    const readback = await readClaudePlugins(this.ports, signal)
    for (const expected of plugins.filter(plugin => managed.has(plugin.pluginId))) {
      if (!readback.plugins.some(item => item.pluginId === expected.pluginId && item.installed && item.enabled === expected.enabled)) {
        failed.push(expected.pluginId)
      }
    }
    for (const pluginId of removed) {
      if (readback.plugins.some(item => item.pluginId === pluginId && item.installed)) kept.push(pluginId)
      else managed.delete(pluginId)
    }
    if (failed.length || kept.length) {
      throw new Error([failed.length ? `Could not sync ${[...new Set(failed)].join(', ')}` : '',
        kept.length ? `Could not remove ${kept.join(', ')}` : ''].filter(Boolean).join(' · '))
    }
    const done = removed.length ? ` · Removed ${removed.join(', ')}` : ''
    return `${plugins.length} plugins in sync${done}`
  }

  private async installedVersion(harness: MaintainedHarness, signal: AbortSignal): Promise<string | null | undefined> {
    const binary = await this.ports.find(harness)
    if (!binary) return undefined
    const result = await this.ports.run(binary, ['--version'], { signal, timeoutMs: 15_000 })
    const version = result.code === 0 ? versionOf(result.stdout) : null
    if (!version) throw new DomainError('COMPUTER_HARNESS_VERSION_UNAVAILABLE',
      `${harness} version inspection failed (exit ${result.code}).`, 503)
    return version
  }

  private latestVersions(signal: AbortSignal) {
    if (this.latest && Date.now() - this.latest.at < LATEST_MS) return this.latest.value
    const value = (async () => {
      const npm = await this.ports.find('npm')
      if (!npm) throw new DomainError('COMPUTER_LATEST_VERSION_UNAVAILABLE',
        'Latest version inspection is unavailable: npm is not installed.', 503)
      const entries = await Promise.all((['codex', 'claude'] as const).map(async harness => {
        const result = await this.ports.run(npm, ['view', PACKAGES[harness], 'version'], { signal, timeoutMs: 20_000 })
        const version = result.code === 0 ? versionOf(result.stdout.trim()) : null
        if (!version) throw new DomainError('COMPUTER_LATEST_VERSION_UNAVAILABLE',
          `Latest ${harness} version inspection failed (exit ${result.code}).`, 503)
        return [harness, version] as const
      }))
      return Object.fromEntries(entries)
    })()
    this.latest = { at: Date.now(), value }
    void value.catch(() => { this.latest = undefined })
    return value
  }

  private async packageUpdates(signal: AbortSignal): Promise<{ pending: number; installable: number } | null> {
    const apt = await this.ports.find('apt-get')
    if (!apt) return null
    const result = await this.ports.run(apt, ['-s', '-o', 'Debug::NoLocking=1', '--with-new-pkgs', 'upgrade'],
      { signal, timeoutMs: 60_000 })
    if (result.code !== 0) throw new DomainError('COMPUTER_PACKAGE_UPDATES_UNAVAILABLE',
      `Package updates inspection failed (exit ${result.code}).`, 503)
    const counts = result.stdout.match(/(\d+) upgraded, (\d+) newly installed, \d+ to remove and (\d+) not upgraded\./u)
    if (!counts) throw new DomainError('COMPUTER_PACKAGE_UPDATES_UNAVAILABLE',
      'Package updates inspection returned invalid output.', 503)
    return { pending: Number(counts[1]) + Number(counts[3]), installable: Number(counts[1]) + Number(counts[2]) }
  }

  private async sudo(signal: AbortSignal): Promise<boolean> {
    const result = await this.ports.run('sudo', ['-n', 'true'], { signal, timeoutMs: 10_000 })
    if (result.code === 0) return true
    if (result.code === 1 && /a password is required|not allowed to execute|not in the sudoers/iu.test(result.stderr)) return false
    throw new DomainError('COMPUTER_PRIVILEGE_CHECK_UNAVAILABLE', `Sudo inspection failed (exit ${result.code}).`, 503)
  }

  private async requireSudo(signal: AbortSignal) {
    if (!await this.sudo(signal)) throw new Error('This computer needs passwordless sudo for OS updates and restarts.')
  }
}

/** User-scope Claude MCP servers from ~/.claude.json (CLAUDE_CONFIG_DIR when set). */
export async function claudeUserMcpServers(ports: Pick<MaintenancePorts, 'environment' | 'readText'>): Promise<Record<string, unknown>> {
  const directory = ports.environment.CLAUDE_CONFIG_DIR
  const file = directory ? join(directory, '.claude.json') : join(ports.environment.HOME ?? homedir(), '.claude.json')
  const text = await ports.readText(file)
  if (!text) return {}
  const value = JSON.parse(text) as { mcpServers?: Record<string, unknown> }
  return value.mcpServers && typeof value.mcpServers === 'object' ? value.mcpServers : {}
}

export async function installedPlugins(ports: Pick<MaintenancePorts, 'run'>, codex: string, signal: AbortSignal): Promise<string[]> {
  const listed = await ports.run(codex, ['plugin', 'list', '--json'], { signal, timeoutMs: 120_000 })
  if (listed.code !== 0) {
    throw new Error('Codex could not list its plugins. Update or reinstall Codex on this computer, then retry sync.')
  }
  const value = JSON.parse(listed.stdout) as { installed?: { pluginId?: unknown; installed?: unknown }[] }
  return (value.installed ?? []).flatMap(entry => typeof entry.pluginId === 'string' && entry.installed !== false ? [entry.pluginId] : [])
}

/** Configured plugin marketplaces; only Git sources can be added on another computer. */
export async function pluginMarketplaces(ports: Pick<MaintenancePorts, 'run'>, codex: string, signal: AbortSignal): Promise<{ name: string; gitSource: string | null; local: boolean }[]> {
  const listed = await ports.run(codex, ['plugin', 'marketplace', 'list', '--json'], { signal, timeoutMs: 60_000 })
  if (listed.code !== 0) throw new Error('Codex could not list its plugin marketplaces.')
  const value = JSON.parse(listed.stdout) as { marketplaces?: { name?: unknown; marketplaceSource?: { sourceType?: unknown; source?: unknown } }[] }
  return (value.marketplaces ?? []).flatMap(entry => typeof entry.name !== 'string' ? [] : [{ name: entry.name,
    gitSource: entry.marketplaceSource?.sourceType === 'git' && typeof entry.marketplaceSource.source === 'string' ? entry.marketplaceSource.source : null,
    // A local marketplace is a folder on this computer (for example the Codex app's own runtime) and cannot be copied.
    local: entry.marketplaceSource?.sourceType === 'local' }])
}

export function systemMaintenancePorts(environment: NodeJS.ProcessEnv = process.env,
  binaries: Readonly<Partial<Record<string, string>>> = {}): MaintenancePorts {
  const home = environment.HOME ?? homedir()
  const directories = [join(home, '.local', 'bin'), ...(environment.PATH ?? '').split(delimiter), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((value, index, all) => value.startsWith('/') && all.indexOf(value) === index)
  const path = directories.join(delimiter)
  const run: MaintenancePorts['run'] = (binary, args, options) => new Promise((resolve, reject) => {
    execFile(binary, args, { signal: options.signal, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8', env: { ...environment, PATH: path, NO_COLOR: '1', CI: '1', LC_ALL: 'C' } },
    (error, stdout, stderr) => {
      if (error && maintenanceError(error, '') !== error.message) {
        reject(new Error(maintenanceError(error, 'Maintenance command failed.'), { cause: error }))
        return
      }
      let code: number | null = 0
      if (error) code = typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout, stderr })
    })
  })
  return {
    environment,
    async find(name) {
      const selected = binaries[name]
      const candidates = selected ? [selected] : directories.map(directory => join(directory, name))
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.X_OK)
        } catch (error) {
          if (!selected) continue
          const code = (error as NodeJS.ErrnoException).code ?? 'ACCESS_FAILED'
          throw executableUnavailable(name, candidate, home, code)
        }
        if (name !== 'codex' && name !== 'claude') return candidate
        let probe
        try {
          probe = await run(candidate, ['--version'], { signal: AbortSignal.timeout(15_000), timeoutMs: 15_000 })
        } catch {
          throw executableUnavailable(name, candidate, home, 'version probe failed or timed out')
        }
        if (probe.code === 0 && versionOf(probe.stdout)) return candidate
        throw executableUnavailable(name, candidate, home, 'version probe failed; the installation may be incomplete')
      }
      return null
    },
    run,
    exists: async target => {
      try { await access(target); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    readText: async target => {
      try {
        return await readFile(target, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async writePrivateText(target, text) {
      try {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const temporary = `${target}.${randomUUID()}.tmp`
        await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
        await rename(temporary, target)
      } catch (error) {
        if (error instanceof Error && maintenanceError(error, '') !== error.message) {
          throw new Error(maintenanceError(error, 'Maintenance storage failed.'), { cause: error })
        }
        throw error
      }
    },
    disk: async target => {
      const value = await statfs(target)
      return { freeBytes: value.bavail * value.bsize, totalBytes: value.blocks * value.bsize }
    },
    later: (fn, ms) => { setTimeout(fn, ms).unref() },
    now: () => new Date(),
  }
}
