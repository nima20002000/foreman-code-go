import {
  HarnessConfigurationSchema, type HarnessConfiguration,
} from '@graphql/contracts'
import { HarnessOptionsResultSchema } from '@graphql/contracts/management'
import { QualificationCache } from './qualificationCache.js'
import { qualificationError } from './qualificationErrors.js'
import { NativeHarnessFactories } from './runtimeFactory.js'
import { requireHarnessQualification } from './qualification/gate.js'
import { harnessSettingSupport } from './operatorOptions.js'
import { runCommand } from './process.js'
import { HarnessExecutionError } from './errors.js'

export class NativeConfigurationService {
  private readonly catalogCache = new QualificationCache<ReturnType<typeof HarnessOptionsResultSchema.parse>>()
  private readonly configurationChecks = new QualificationCache<Awaited<ReturnType<NativeConfigurationService['inspectConfiguration']>>>()
  invalidateOptions(): void { this.catalogCache.clear(); this.configurationChecks.clear() }
  async shutdownChecks(): Promise<void> { await Promise.all([this.catalogCache.close(), this.configurationChecks.close()]) }
  private readonly factories: NativeHarnessFactories
  constructor(private readonly codexBinary: string, private readonly openCodeBinary: string, private readonly directory: string, factories?: NativeHarnessFactories, _claude?: unknown, private readonly command: typeof runCommand = runCommand) {
    void _claude
    this.factories = factories ?? new NativeHarnessFactories({ codexBinary, openCodeBinary })
  }

  async qualifyConfiguration(input: HarnessConfiguration) {
    const value = HarnessConfigurationSchema.parse(input)
    try { return await this.configurationChecks.get(JSON.stringify(value), () => this.inspectConfiguration(value)) }
    catch (error) { throw qualificationError(error) }
  }

  private async inspectConfiguration(value: HarnessConfiguration) {
    const signal = AbortSignal.timeout(60_000)
    return this.factories.qualifyConfiguration(value, this.directory, signal)
  }

  async options(harness: 'codex' | 'opencode') {
    try { return await this.catalogCache.get(harness, () => this.discoverOptions(harness)) }
    catch (error) { throw qualificationError(error) }
  }

  async refreshOptions(harness: 'codex' | 'opencode', refresh: 'catalog' | 'upstream' = 'catalog') {
    try {
      try {
        if (refresh === 'upstream') {
          if (harness !== 'opencode') throw new HarnessExecutionError('CODEX_MODEL_REFRESH_UNSUPPORTED', 'Codex has no upstream catalog refresh command.')
          const signal = AbortSignal.timeout(60_000)
          const version = await this.command(this.openCodeBinary, ['--version'], this.directory, signal)
          if (version.exitCode !== 0) {
            throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'The configured OpenCode CLI is not the qualified release.')
          }
          await requireHarnessQualification('opencode', (version.stdout || version.stderr).trim(), this.openCodeBinary)
          // Update the shared registry without loading plugins; the fresh /provider read still filters connected providers.
          const result = await this.command(this.openCodeBinary, ['models', '--refresh', '--pure'], this.directory, signal)
          if (result.exitCode !== 0) throw new HarnessExecutionError('OPENCODE_MODEL_REFRESH_UNAVAILABLE', 'OpenCode could not refresh its models.dev cache.')
        }
      } finally { this.invalidateOptions() }
      return await this.options(harness)
    } catch (error) { throw qualificationError(error) }
  }

  private async discoverOptions(harness: 'codex' | 'opencode') {
    const signal = AbortSignal.timeout(60_000)
    if (harness === 'codex') {
      const allocated = this.factories.allocate({ harness: 'codex', role: 'diagnostics',
        workingDirectory: this.directory, ownerAgentId: 'catalog-inspection', appMcpAccess: 'none' })
      if (allocated.harness !== 'codex') throw new Error('The Codex driver returned another harness.')
      const manager = allocated.manager
      try {
        const options = await manager.discoverModels(this.directory, signal)
        return HarnessOptionsResultSchema.parse({ harness, ...options, authenticated: true, nativeAgents: [],
          settings: harnessSettingSupport(harness), restrictions: ['Global qualification directory; workspace MCP diagnostics are separate.', 'No native session or model turn was created.'], checkedAt: new Date().toISOString() })
      } finally { await this.factories.disposeAuxiliary(manager) }
    }
    const allocated = this.factories.allocate({ harness: 'opencode', role: 'diagnostics',
      workingDirectory: this.directory, ownerAgentId: 'catalog-inspection', appMcpAccess: 'none' })
    if (allocated.harness !== 'opencode') throw new Error('The OpenCode driver returned another harness.')
    const manager = allocated.manager
    try {
      const options = await manager.discoverOptions(this.directory, signal)
      return HarnessOptionsResultSchema.parse({ harness, ...options, settings: harnessSettingSupport(harness),
        restrictions: ['Only connected providers are selectable.', 'An empty variant selects the native default.', 'No native session or model turn was created.'], checkedAt: new Date().toISOString() })
    } finally { await this.factories.disposeAuxiliary(manager) }
  }
}
