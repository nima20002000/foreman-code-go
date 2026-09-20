import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { CodexPluginSummarySchema, type CodexPluginDetailResult, type CodexPluginSummary } from '@graphql/contracts/management'
import { DomainError } from '../errors.js'
import { assertCodexUnchanged, canonical, qualifyCodex, QUALIFIED_CODEX_VERSION } from './codexProtocol.js'
import { runCommand } from './process.js'

const NativeEntry = z.object({ pluginId: z.string(), name: z.string(), marketplaceName: z.string(),
  version: z.string().nullable().optional(), installed: z.boolean(), enabled: z.boolean(),
  source: z.object({ source: z.string() }).passthrough(), installPolicy: z.string(), authPolicy: z.string() }).passthrough()
const NativeCatalog = z.object({ installed: z.array(NativeEntry).max(10_000), available: z.array(NativeEntry).max(10_000) }).passthrough()
type Catalog = { installed: CodexPluginSummary[]; available: CodexPluginSummary[]; revision: string }

export interface CodexPluginAdapter {
  list(signal: AbortSignal): Promise<Catalog>
  detail(plugin: CodexPluginSummary): Promise<CodexPluginDetailResult['contents']>
  change(pluginId: string, action: 'install' | 'remove', signal: AbortSignal): Promise<void>
}

const safePart = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export class NativeCodexPlugins implements CodexPluginAdapter {
  constructor(private readonly binary: string, private readonly directory: string) {}

  private async command(args: string[], signal: AbortSignal) {
    const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
    for (const key of Object.keys(environment)) if (/^(?:GRAPHQL_|OPERATOR_|DATABASE_URL$|TEST_DATABASE_URL$|PGPASSWORD$)/.test(key)) delete environment[key]
    const qualified = await qualifyCodex(this.binary, QUALIFIED_CODEX_VERSION, this.directory, environment, true, signal)
    await assertCodexUnchanged(qualified)
    return runCommand(qualified.binary, args, this.directory, signal, environment)
  }

  async list(signal: AbortSignal): Promise<Catalog> {
    const result = await this.command(['plugin', 'list', '--available', '--json'], signal)
    if (result.exitCode !== 0 || result.stdout.length > 8_000_000) throw new DomainError('CODEX_PLUGIN_CATALOG_UNAVAILABLE', 'Codex could not list its plugin catalog.', 503)
    let native: z.infer<typeof NativeCatalog>
    try { native = NativeCatalog.parse(JSON.parse(result.stdout)) }
    catch { throw new DomainError('CODEX_PLUGIN_CATALOG_INVALID', 'Codex returned an unsupported plugin catalog.', 502) }
    const convert = (entry: z.infer<typeof NativeEntry>): CodexPluginSummary => CodexPluginSummarySchema.parse({
      pluginId: entry.pluginId, name: entry.name, marketplaceName: entry.marketplaceName, version: entry.version ?? null,
      installed: entry.installed, enabled: entry.enabled,
      sourceType: ['local', 'git', 'git-subdir', 'remote'].includes(entry.source.source) ? entry.source.source : 'other',
      installPolicy: entry.installPolicy, authPolicy: entry.authPolicy,
    })
    try {
      const installed = native.installed.map(convert)
      const availableById = new Map<string, CodexPluginSummary>()
      for (const entry of native.available.map(convert)) {
        if (installed.some((item) => item.pluginId === entry.pluginId)) continue
        const previous = availableById.get(entry.pluginId)
        // The remote catalog can advertise more than one version for one CLI selector.
        if (!previous || (entry.version ?? '').localeCompare(previous.version ?? '', undefined, { numeric: true }) > 0) availableById.set(entry.pluginId, entry)
      }
      const available = [...availableById.values()]
      return { installed, available, revision: `sha256:${createHash('sha256').update(canonical([installed, available])).digest('hex')}` }
    } catch { throw new DomainError('CODEX_PLUGIN_CATALOG_INVALID', 'Codex returned an unsupported plugin catalog.', 502) }
  }

  async change(pluginId: string, action: 'install' | 'remove', signal: AbortSignal): Promise<void> {
    const result = await this.command(['plugin', action === 'install' ? 'add' : 'remove', pluginId, '--json'], signal)
    if (result.exitCode !== 0) throw new DomainError('CODEX_PLUGIN_CHANGE_UNCONFIRMED', 'Codex did not confirm the plugin change. Refresh the catalog before another action.', 409)
  }

  async detail(plugin: CodexPluginSummary): Promise<CodexPluginDetailResult['contents']> {
    if (!plugin.installed || !safePart(plugin.name) || !safePart(plugin.marketplaceName)) return { status: 'unknown' }
    const version = plugin.version ?? 'local'
    if (!safePart(version)) return { status: 'unknown' }
    const cache = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugins', 'cache')
    const root = resolve(cache, plugin.marketplaceName, plugin.name, version)
    try {
      const base = await realpath(cache)
      const directory = await realpath(root)
      if (!directory.startsWith(base + sep)) return { status: 'unknown' }
      const read = async (file: string): Promise<Record<string, unknown> | undefined> => {
        const path = resolve(directory, file)
        if (!path.startsWith(directory + sep) || await realpath(path) !== path) return undefined
        const data = await readFile(path)
        if (data.length > 65_536) return undefined
        return object(JSON.parse(data.toString('utf8')))
      }
      const manifest = await read('plugin.json').catch(() => undefined) ?? await read('.codex-plugin/plugin.json').catch(() => undefined)
      if (!manifest) return { status: 'unknown' }
      const skillEntries = await readdir(join(directory, 'skills'), { withFileTypes: true }).catch(() => undefined)
      if (manifest.skills && !skillEntries) return { status: 'unknown' }
      const skillNames: string[] = []
      for (const item of skillEntries ?? []) {
        if (!item.isDirectory()) continue
        const entry = join(directory, 'skills', item.name, 'SKILL.md')
        if (await lstat(entry).then((stat) => stat.isFile() && !stat.isSymbolicLink(), () => false)) skillNames.push(item.name)
      }
      skillNames.sort()
      const mcpFile = await read('mcp.json').catch(() => undefined) ?? await read('.mcp.json').catch(() => undefined)
      const mcpServers = Object.keys(object(mcpFile?.mcpServers ?? (typeof manifest.mcpServers === 'object' ? manifest.mcpServers : undefined))).sort()
      const extension = object(object(manifest.extensions)['com.openai'])
      const appDeclaration = extension.apps ?? manifest.apps
      const appFile = typeof appDeclaration === 'string' && appDeclaration.startsWith('./')
        ? await read(appDeclaration).catch(() => undefined) : await read('.app.json').catch(() => undefined)
      const apps = Object.keys(object(appFile?.apps ?? (typeof appDeclaration === 'object' ? appDeclaration : undefined))).sort()
      const hooksDeclaration = extension.hooks ?? manifest.hooks
      const hookFile = typeof hooksDeclaration === 'string' && hooksDeclaration.startsWith('./')
        ? await read(hooksDeclaration).catch(() => undefined) : await read('hooks/hooks.json').catch(() => undefined)
      const hooks = Object.keys(object(hookFile?.hooks ?? (typeof hooksDeclaration === 'object' ? hooksDeclaration : undefined))).sort()
      if (manifest.mcpServers && !mcpFile && !mcpServers.length) return { status: 'unknown' }
      if (appDeclaration && !appFile && !apps.length) return { status: 'unknown' }
      if (hooksDeclaration && !hookFile && !hooks.length) return { status: 'unknown' }
      return { status: 'known', skills: skillNames, hooks, mcpServers, apps }
    } catch { return { status: 'unknown' } }
  }
}
