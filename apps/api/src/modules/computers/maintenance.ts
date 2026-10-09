import { readClaudePlugins, claudeCliResult } from './claudePlugins.js'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  MaintenanceStatusSchema, MaintenanceTaskSchema, type MaintainedHarness, type MaintenanceStatus, type MaintenanceTask,
  type MaintenanceTaskStart, type SyncedMarketplace, type SyncedMcpServer,
} from '@foreman-code/contracts/computer-maintenance'

export interface MaintenancePorts {
  environment: NodeJS.ProcessEnv
  /** Absolute executable path, or null when not installed. */
  find(name: string): Promise<string | null>
  run(binary: string, args: string[], options: { signal: AbortSignal; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }>
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string | null>
  /** Writes a private (0600) file atomically, creating its directory. */
  writePrivateText(path: string, text: string): Promise<void>
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>
  /** Runs fn after ms; restart uses it so the reply reaches Main before the computer goes down. */
  later(fn: () => void, ms: number): void
  now(): Date
  /** A Worker with an installer-selected Codex moves that selection to the freshly installed Codex, so the computer
   * actually uses the update. Returns the selected binary, or null when this computer has no Codex selection. */
  selectInstalledCodex?(signal: AbortSignal): Promise<string | null>
}

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

/**
 * Keeps this computer's harnesses, packages, MCP servers and Codex plugins current. Runs on Main for itself and on every
 * paired computer for Main's requests. Long work runs as background tasks that status readback reports.
 */
export class ComputerMaintenance {
  private readonly tasks: MaintenanceTask[] = []
  private latest: { at: number; value: Promise<Partial<Record<MaintainedHarness, string | null>>> } | undefined
  constructor(private readonly ports: MaintenancePorts = systemMaintenancePorts()) {}

  async status(signal: AbortSignal): Promise<MaintenanceStatus> {
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
      harnesses: (['codex', 'claude'] as const).map((harness, index) => ({ harness, installed: versions[index] !== undefined,
        version: versions[index] ?? null, latest: latest[harness] ?? null })),
      system: { packageUpdates: packageUpdates?.pending ?? null, rebootRequired, sudo, disk },
      tasks: [...this.tasks].reverse(), observedAt: this.ports.now().toISOString(),
    })
  }

  /** Starts one task and returns it at once; status readback follows its progress. */
  start(request: MaintenanceTaskStart): MaintenanceTask {
    const running = this.tasks.find(task => task.state === 'running' && task.kind === request.kind)
    if (running) return structuredClone(running)
    const task: MaintenanceTask = { id: randomUUID(), kind: request.kind, state: 'running',
      startedAt: this.ports.now().toISOString(), finishedAt: null, summary: 'Running…', outputTail: '' }
    this.tasks.push(task)
    if (this.tasks.length > 20) this.tasks.splice(0, this.tasks.length - 20)
    void this.perform(request, task).then(summary => this.finish(task, 'succeeded', summary),
      (error: unknown) => this.finish(task, 'failed', error instanceof Error ? error.message : 'Maintenance failed.'))
    return MaintenanceTaskSchema.parse(structuredClone(task))
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
  private writeLedger(ledger: FleetLedger) { return this.ports.writePrivateText(this.ledgerPath(), `${JSON.stringify(ledger)}\n`) }

  private finish(task: MaintenanceTask, state: 'succeeded' | 'failed', summary: string) {
    task.state = state
    task.summary = summary.slice(0, 2000)
    task.finishedAt = this.ports.now().toISOString()
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
            if (after !== latest[harness]) {
              throw new Error(`${LABELS[harness]} is still ${after}; latest published version is ${latest[harness]}.`)
            }
            changes.push(`${LABELS[harness]} ${before ?? 'not installed'} → ${after}`)
          } catch (error) {
            failures.push(error instanceof Error ? error.message : `${LABELS[harness]} update failed.`)
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
        this.ports.later(() => { void this.ports.run('sudo', ['-n', 'systemctl', 'reboot'], { signal: AbortSignal.timeout(60_000), timeoutMs: 60_000 }) }, 3_000)
        return 'Restarting in a few seconds.'
      }
      case 'sync-mcp': {
        const ledger = await this.readLedger()
        const results: string[] = []
        for (const harness of ['codex', 'claude'] as const) {
          const synced = await this.syncMcp(harness, request.servers[harness], ledger.mcp[harness], step, signal)
          ledger.mcp[harness] = synced.managed
          if (synced.summary) results.push(`${LABELS[harness]}: ${synced.summary}`)
        }
        await this.writeLedger(ledger)
        return results.join(' · ') || 'Nothing to sync'
      }
      case 'sync-plugins': {
        const ledger = await this.readLedger()
        const results: string[] = []
        const failures: string[] = []
        const sync = [
          { name: 'Codex', run: async () => {
            const synced = await this.syncPlugins(request.plugins, request.marketplaces, ledger.codexPlugins, step, signal)
            ledger.codexPlugins = synced.managed
            return synced.summary
          } },
          { name: 'Claude', run: async () => {
            const synced = await this.syncClaudePlugins(request, ledger.claudePlugins, step, signal)
            ledger.claudePlugins = synced.managed
            return synced.summary
          } },
        ]
        for (const harness of sync) {
          try { results.push(`${harness.name}: ${await harness.run()}`) }
          catch (error) { failures.push(`${harness.name}: ${error instanceof Error ? error.message : 'Plugin sync failed.'}`) }
        }
        await this.writeLedger(ledger)
        if (failures.length) throw new Error([...results, ...failures].join(' · '))
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
    await step(npm, ['install', '--global', '--prefix', join(home, '.local'), `${PACKAGES.codex}@latest`], 'npm install @openai/codex@latest')
  }

  /** Adds Main's servers this computer lacks and removes the ones it received from Main earlier that Main has since
   * removed. Servers the computer has on its own are never touched. */
  private async syncMcp(harness: MaintainedHarness, servers: readonly SyncedMcpServer[], previous: readonly string[], step: Step,
    signal: AbortSignal): Promise<{ summary: string; managed: string[] }> {
    const wanted = servers.map(server => server.name)
    const binary = await this.ports.find(harness)
    if (!binary) return { summary: servers.length || previous.length ? 'not installed, skipped' : '', managed: [...previous] }
    if (!servers.length && !previous.length) return { summary: '', managed: [] }
    const existing = new Set(await this.mcpNames(harness, binary, signal))
    const added: string[] = [], removed: string[] = [], kept: string[] = []
    for (const name of previous) {
      if (wanted.includes(name) || !existing.has(name)) continue
      const result = await step(binary, harness === 'codex' ? ['mcp', 'remove', name] : ['mcp', 'remove', '--scope', 'user', name],
        `${harness} mcp remove ${name}`, { timeoutMs: 30_000, allowFailure: true })
      ;(result.code === 0 ? removed : kept).push(name)
    }
    for (const server of servers) {
      if (existing.has(server.name)) continue
      if (harness === 'codex') {
        const label = `codex mcp add ${server.name}`
        // Codex saves the server, then waits for a browser sign-in on OAuth servers. That sign-in
        // belongs to the person at that computer, so a saved server counts as added.
        const result = await step(binary, server.transport === 'http'
          ? ['mcp', 'add', server.name, '--url', server.url, ...(server.bearerTokenEnvVar ? ['--bearer-token-env-var', server.bearerTokenEnvVar] : [])]
          : ['mcp', 'add', server.name, '--', server.command, ...server.args], label, { timeoutMs: 30_000, allowFailure: true })
        if (result.code !== 0) {
          if (!(await this.mcpNames(harness, binary, signal)).includes(server.name)) throw new Error(`${label} failed.`)
          added.push(`${server.name} (sign in on this computer)`)
          continue
        }
      } else {
        const definition = server.transport === 'http' ? { type: 'http', url: server.url } : { type: 'stdio', command: server.command, args: server.args }
        await step(binary, ['mcp', 'add-json', '--scope', 'user', server.name, JSON.stringify(definition)], `claude mcp add-json ${server.name}`)
      }
      added.push(server.name)
    }
    // A server that could not be removed stays managed, so the next sync tries again.
    const managed = [...wanted, ...kept]
    if (kept.length) throw new Error(`Could not remove ${kept.join(', ')}`)
    const summary = [added.length ? `Added ${added.join(', ')}` : '', removed.length ? `Removed ${removed.join(', ')}` : '']
      .filter(Boolean).join(' · ')
    return { summary: summary || 'Already in sync', managed }
  }

  private async mcpNames(harness: MaintainedHarness, binary: string, signal: AbortSignal): Promise<string[]> {
    if (harness === 'codex') {
      const listed = await this.ports.run(binary, ['mcp', 'list', '--json'], { signal, timeoutMs: 60_000 })
      if (listed.code !== 0) throw new Error('Codex could not list its MCP servers.')
      return (JSON.parse(listed.stdout) as { name?: unknown }[]).flatMap(entry => typeof entry.name === 'string' ? [entry.name] : [])
    }
    return Object.keys(await claudeUserMcpServers(this.ports))
  }

  private async syncPlugins(plugins: readonly string[], marketplaces: readonly SyncedMarketplace[], previous: readonly string[],
    step: Step, signal: AbortSignal): Promise<{ summary: string; managed: string[] }> {
    if (!plugins.length && !previous.length) return { summary: 'Nothing to sync', managed: [] }
    const codex = await this.ports.find('codex')
    if (!codex) throw new Error('Codex is not installed on this computer.')
    const installed = new Set(await installedPlugins(this.ports, codex, signal))
    const missing = plugins.filter(plugin => !installed.has(plugin))
    const known = new Set(missing.length ? (await pluginMarketplaces(this.ports, codex, signal)).map(marketplace => marketplace.name) : [])
    const added: string[] = [], failed: string[] = [], removed: string[] = [], kept: string[] = []
    for (const plugin of previous) {
      if (plugins.includes(plugin) || !installed.has(plugin)) continue
      const result = await step(codex, ['plugin', 'remove', plugin], `codex plugin remove ${plugin}`, { allowFailure: true })
      ;(result.code === 0 ? removed : kept).push(plugin)
    }
    for (const marketplace of marketplaces) {
      if (known.has(marketplace.name) || !missing.some(plugin => plugin.endsWith(`@${marketplace.name}`))) continue
      const result = await step(codex, ['plugin', 'marketplace', 'add', marketplace.source], `codex plugin marketplace add ${marketplace.source}`, { allowFailure: true })
      if (result.code === 0) known.add(marketplace.name)
    }
    // One plugin that cannot install does not keep the others from installing.
    for (const plugin of missing) {
      const result = await step(codex, ['plugin', 'add', plugin], `codex plugin add ${plugin}`, { allowFailure: true })
      ;(result.code === 0 ? added : failed).push(plugin)
    }
    const managed = [...plugins, ...kept]
    const summary = [added.length ? `Installed ${added.join(', ')}` : '', removed.length ? `Removed ${removed.join(', ')}` : '',
      failed.length ? `Could not install ${failed.join(', ')}` : '', kept.length ? `Could not remove ${kept.join(', ')}` : '']
      .filter(Boolean).join(' · ')
    if (failed.length || kept.length) throw new Error(summary)
    return { summary: summary || 'Already in sync', managed }
  }

  private async syncClaudePlugins(
    request: Extract<MaintenanceTaskStart, { kind: 'sync-plugins' }>, previous: readonly string[], step: Step, signal: AbortSignal,
  ): Promise<{ summary: string; managed: string[] }> {
    const wanted = request.claudePlugins.map(plugin => plugin.pluginId)
    if (!wanted.length && !previous.length) return { summary: 'Nothing to sync', managed: [] }
    const claude = await this.ports.find('claude')
    if (!claude) throw new Error('Claude Code is not installed on this computer.')
    const catalog = await readClaudePlugins(this.ports, signal)
    const installed = new Map(catalog.plugins.filter(item => item.installed).map(item => [item.pluginId, item]))
    const known = new Set(catalog.marketplaces.map(item => item.name))
    const failed: string[] = [], removed: string[] = [], kept: string[] = []
    for (const pluginId of previous) {
      if (wanted.includes(pluginId) || !installed.has(pluginId)) continue
      const result = await step(claude, ['plugin', 'uninstall', pluginId, '--scope', 'user', '--json'],
        `claude plugin uninstall ${pluginId}`, { allowFailure: true })
      ;(result.code === 0 && claudeCliResult(result.stdout)?.outcome === 'ok' ? removed : kept).push(pluginId)
    }
    for (const marketplace of request.claudeMarketplaces) {
      if (known.has(marketplace.name)) continue
      const result = await step(claude, ['plugin', 'marketplace', 'add', marketplace.source, '--json'],
        `claude plugin marketplace add ${marketplace.source}`, { allowFailure: true })
      if (result.code === 0 && claudeCliResult(result.stdout)?.outcome === 'ok') known.add(marketplace.name)
      else failed.push(`marketplace ${marketplace.name}`)
    }
    for (const plugin of request.claudePlugins) {
      const existing = installed.get(plugin.pluginId)
      const actions: string[] = []
      if (!existing) actions.push('install')
      if (!plugin.enabled) actions.push('disable')
      else if (existing && !existing.enabled) actions.push('enable')
      for (const action of actions) {
        const result = await step(claude, ['plugin', action, plugin.pluginId, '--scope', 'user', '--json'],
          `claude plugin ${action} ${plugin.pluginId}`, { allowFailure: true })
        if (result.code !== 0 || claudeCliResult(result.stdout)?.outcome !== 'ok') {
          failed.push(plugin.pluginId)
          break
        }
      }
    }
    const readback = await readClaudePlugins(this.ports, signal)
    for (const expected of request.claudePlugins) {
      if (!readback.plugins.some(item => item.pluginId === expected.pluginId && item.installed && item.enabled === expected.enabled)) {
        failed.push(expected.pluginId)
      }
    }
    for (const pluginId of removed) {
      if (readback.plugins.some(item => item.pluginId === pluginId && item.installed)) kept.push(pluginId)
    }
    const managed = [...wanted, ...kept]
    if (failed.length || kept.length) {
      throw new Error([failed.length ? `Could not sync ${[...new Set(failed)].join(', ')}` : '',
        kept.length ? `Could not remove ${kept.join(', ')}` : ''].filter(Boolean).join(' · '))
    }
    const done = removed.length ? ` · Removed ${removed.join(', ')}` : ''
    return { summary: `${request.claudePlugins.length} plugins in sync${done}`, managed }
  }

  private async installedVersion(harness: MaintainedHarness, signal: AbortSignal): Promise<string | null | undefined> {
    const binary = await this.ports.find(harness)
    if (!binary) return undefined
    const result = await this.ports.run(binary, ['--version'], { signal, timeoutMs: 15_000 }).catch(() => null)
    return result?.code === 0 ? versionOf(result.stdout) : null
  }

  private latestVersions(signal: AbortSignal) {
    if (this.latest && Date.now() - this.latest.at < LATEST_MS) return this.latest.value
    const value = (async () => {
      const npm = await this.ports.find('npm')
      if (!npm) return {}
      const entries = await Promise.all((['codex', 'claude'] as const).map(async harness => {
        const result = await this.ports.run(npm, ['view', PACKAGES[harness], 'version'], { signal, timeoutMs: 20_000 }).catch(() => null)
        return [harness, result?.code === 0 ? result.stdout.trim() || null : null] as const
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
      { signal, timeoutMs: 60_000 }).catch(() => null)
    if (result?.code !== 0) return null
    const counts = result.stdout.match(/(\d+) upgraded, (\d+) newly installed, \d+ to remove and (\d+) not upgraded\./u)
    if (!counts) return null
    return { pending: Number(counts[1]) + Number(counts[3]), installable: Number(counts[1]) + Number(counts[2]) }
  }

  private async sudo(signal: AbortSignal): Promise<boolean> {
    const result = await this.ports.run('sudo', ['-n', 'true'], { signal, timeoutMs: 10_000 }).catch(() => null)
    return result?.code === 0
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
  if (listed.code !== 0) throw new Error('Codex could not list its plugins.')
  const value = JSON.parse(listed.stdout) as { installed?: { pluginId?: unknown; installed?: unknown }[] }
  return (value.installed ?? []).flatMap(entry => typeof entry.pluginId === 'string' && entry.installed !== false ? [entry.pluginId] : [])
}

/** Configured plugin marketplaces; only Git sources can be added on another computer. */
export async function pluginMarketplaces(ports: Pick<MaintenancePorts, 'run'>, codex: string, signal: AbortSignal): Promise<{ name: string; gitSource: string | null }[]> {
  const listed = await ports.run(codex, ['plugin', 'marketplace', 'list', '--json'], { signal, timeoutMs: 60_000 })
  if (listed.code !== 0) throw new Error('Codex could not list its plugin marketplaces.')
  const value = JSON.parse(listed.stdout) as { marketplaces?: { name?: unknown; marketplaceSource?: { sourceType?: unknown; source?: unknown } }[] }
  return (value.marketplaces ?? []).flatMap(entry => typeof entry.name !== 'string' ? [] : [{ name: entry.name,
    gitSource: entry.marketplaceSource?.sourceType === 'git' && typeof entry.marketplaceSource.source === 'string' ? entry.marketplaceSource.source : null }])
}

export function systemMaintenancePorts(environment: NodeJS.ProcessEnv = process.env,
  binaries: Readonly<Partial<Record<string, string>>> = {}): MaintenancePorts {
  const home = environment.HOME ?? homedir()
  const directories = [join(home, '.local', 'bin'), ...(environment.PATH ?? '').split(delimiter), '/usr/local/bin', '/usr/bin', '/bin']
    .filter((value, index, all) => value.startsWith('/') && all.indexOf(value) === index)
  const path = directories.join(delimiter)
  return {
    environment,
    async find(name) {
      const selected = binaries[name]
      if (selected) { try { await access(selected, constants.X_OK); return selected } catch { /* fall back to PATH */ } }
      for (const directory of directories) {
        const candidate = join(directory, name)
        try { await access(candidate, constants.X_OK); return candidate } catch { continue }
      }
      return null
    },
    run: (binary, args, options) => new Promise(resolve => {
      execFile(binary, args, { signal: options.signal, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { ...environment, PATH: path, NO_COLOR: '1', CI: '1', LC_ALL: 'C' } }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0
        resolve({ code, stdout, stderr })
      })
    }),
    exists: async target => { try { await access(target); return true } catch { return false } },
    readText: target => readFile(target, 'utf8').catch(() => null),
    async writePrivateText(target, text) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const temporary = `${target}.${randomUUID()}.tmp`
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    },
    disk: async target => {
      try { const value = await statfs(target); return { freeBytes: value.bavail * value.bsize, totalBytes: value.blocks * value.bsize } }
      catch { return null }
    },
    later: (fn, ms) => { setTimeout(fn, ms).unref() },
    now: () => new Date(),
  }
}
