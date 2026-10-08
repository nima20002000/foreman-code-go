import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
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
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>
  /** Runs fn after ms; restart uses it so the reply reaches Main before the computer goes down. */
  later(fn: () => void, ms: number): void
  now(): Date
}

const PACKAGES: Record<MaintainedHarness, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' }
const LABELS: Record<MaintainedHarness, string> = { codex: 'Codex', claude: 'Claude' }
const LATEST_MS = 60 * 60_000
const LONG_MS = 20 * 60_000
const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=a', 'apt-get', '-y', '-q',
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
      system: { packageUpdates, rebootRequired, sudo, disk },
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
        for (const harness of request.harnesses) {
          const before = await this.installedVersion(harness, signal)
          await this.installLatest(harness, step)
          const after = await this.installedVersion(harness, signal)
          changes.push(`${LABELS[harness]} ${before ?? 'not installed'} → ${after ?? 'unknown'}`)
        }
        this.latest = undefined
        return changes.join(' · ')
      }
      case 'update-system': {
        await this.requireSudo(signal)
        await step('sudo', ['-n', ...APT, 'update'], 'apt-get update')
        const upgrade = await step('sudo', ['-n', ...APT, 'upgrade'], 'apt-get upgrade')
        const upgraded = upgrade.stdout.match(/(\d+) upgraded/u)?.[1] ?? '0'
        const reboot = await this.ports.exists('/var/run/reboot-required')
        return `${upgraded} packages upgraded${reboot ? ' · restart needed' : ''}`
      }
      case 'restart': {
        await this.requireSudo(signal)
        this.ports.later(() => { void this.ports.run('sudo', ['-n', 'systemctl', 'reboot'], { signal: AbortSignal.timeout(60_000), timeoutMs: 60_000 }) }, 3_000)
        return 'Restarting in a few seconds.'
      }
      case 'sync-mcp': {
        const results: string[] = []
        for (const harness of ['codex', 'claude'] as const) {
          if (!request.servers[harness].length) continue
          results.push(`${LABELS[harness]}: ${await this.syncMcp(harness, request.servers[harness], step, signal)}`)
        }
        return results.join(' · ') || 'Nothing to sync'
      }
      case 'sync-plugins': return this.syncPlugins(request.plugins, request.marketplaces, step, signal)
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

  private async syncMcp(harness: MaintainedHarness, servers: readonly SyncedMcpServer[], step: Step, signal: AbortSignal): Promise<string> {
    const binary = await this.ports.find(harness)
    if (!binary) return 'not installed, skipped'
    const existing = new Set(await this.mcpNames(harness, binary, signal))
    const added: string[] = []
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
    return added.length ? `Added ${added.join(', ')}` : 'Already in sync'
  }

  private async mcpNames(harness: MaintainedHarness, binary: string, signal: AbortSignal): Promise<string[]> {
    if (harness === 'codex') {
      const listed = await this.ports.run(binary, ['mcp', 'list', '--json'], { signal, timeoutMs: 60_000 })
      if (listed.code !== 0) throw new Error('Codex could not list its MCP servers.')
      return (JSON.parse(listed.stdout) as { name?: unknown }[]).flatMap(entry => typeof entry.name === 'string' ? [entry.name] : [])
    }
    return Object.keys(await claudeUserMcpServers(this.ports))
  }

  private async syncPlugins(plugins: readonly string[], marketplaces: readonly SyncedMarketplace[], step: Step, signal: AbortSignal): Promise<string> {
    const codex = await this.ports.find('codex')
    if (!codex) throw new Error('Codex is not installed on this computer.')
    const installed = new Set(await installedPlugins(this.ports, codex, signal))
    const missing = plugins.filter(plugin => !installed.has(plugin))
    const known = new Set(missing.length ? (await pluginMarketplaces(this.ports, codex, signal)).map(marketplace => marketplace.name) : [])
    const added: string[] = [], failed: string[] = []
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
    const summary = [added.length ? `Installed ${added.join(', ')}` : '', failed.length ? `Could not install ${failed.join(', ')}` : ''].filter(Boolean).join(' · ')
    if (failed.length) throw new Error(summary)
    return summary || 'Already in sync'
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

  private async packageUpdates(signal: AbortSignal): Promise<number | null> {
    const apt = await this.ports.find('apt-get')
    if (!apt) return null
    const result = await this.ports.run(apt, ['-s', '-o', 'Debug::NoLocking=1', 'upgrade'], { signal, timeoutMs: 60_000 }).catch(() => null)
    return result?.code === 0 ? result.stdout.split('\n').filter(line => line.startsWith('Inst ')).length : null
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
        env: { ...environment, PATH: path, NO_COLOR: '1', CI: '1' } }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0
        resolve({ code, stdout, stderr })
      })
    }),
    exists: async target => { try { await access(target); return true } catch { return false } },
    readText: target => readFile(target, 'utf8').catch(() => null),
    disk: async target => {
      try { const value = await statfs(target); return { freeBytes: value.bavail * value.bsize, totalBytes: value.blocks * value.bsize } }
      catch { return null }
    },
    later: (fn, ms) => { setTimeout(fn, ms).unref() },
    now: () => new Date(),
  }
}
