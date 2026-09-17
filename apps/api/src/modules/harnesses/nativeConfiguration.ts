import {
  HarnessConfigurationSchema, type HarnessConfiguration,
} from '@graphql/contracts'
import { HarnessOptionsResultSchema } from '@graphql/contracts/management'
import { QualificationCache } from './qualificationCache.js'
import { qualificationError } from './qualificationErrors.js'
import { CodexAppServerSessionManager } from './codexAppServer.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './opencodeServer.js'
import { harnessSettingSupport } from './operatorOptions.js'

export class NativeConfigurationService {
  private readonly catalogCache = new QualificationCache<ReturnType<typeof HarnessOptionsResultSchema.parse>>()
  private readonly configurationChecks = new QualificationCache<Awaited<ReturnType<NativeConfigurationService['inspectConfiguration']>>>()
  invalidateOptions(): void { this.catalogCache.clear(); this.configurationChecks.clear() }
  async shutdownChecks(): Promise<void> { await Promise.all([this.catalogCache.close(), this.configurationChecks.close()]) }
  constructor(private readonly codexBinary: string, private readonly openCodeBinary: string, private readonly directory: string) {}

  async qualifyConfiguration(input: HarnessConfiguration) {
    const value = HarnessConfigurationSchema.parse(input)
    try { return await this.configurationChecks.get(JSON.stringify(value), () => this.inspectConfiguration(value)) }
    catch (error) { throw qualificationError(error) }
  }

  private async inspectConfiguration(value: HarnessConfiguration) {
    const signal = AbortSignal.timeout(60_000)
    if (value.harness === 'codex') {
      const manager = new CodexAppServerSessionManager(this.codexBinary)
      try { return await manager.qualifyConfiguration(value, this.directory, signal) }
      finally { await manager.shutdown() }
    }
    const manager = new OpenCodeNativeSessionManager({
      server: new ManagedOpenCodeServer({ binary: this.openCodeBinary, workingDirectory: this.directory,
        ownerAgentId: 'configuration-check', ...(value.advanced ? { advancedConfiguration: value.advanced } : {}) }),
      ownerAgentId: 'configuration-check',
    })
    try { return await manager.qualifyConfiguration(value, this.directory, signal) }
    finally { await manager.dispose() }
  }

  async options(harness: 'codex' | 'opencode') {
    try { return await this.catalogCache.get(harness, () => this.discoverOptions(harness)) }
    catch (error) { throw qualificationError(error) }
  }

  private async discoverOptions(harness: 'codex' | 'opencode') {
    const signal = AbortSignal.timeout(60_000)
    if (harness === 'codex') {
      const manager = new CodexAppServerSessionManager(this.codexBinary)
      try {
        const options = await manager.discoverModels(this.directory, signal)
        return HarnessOptionsResultSchema.parse({ harness, ...options, authenticated: true, nativeAgents: [],
          settings: harnessSettingSupport(harness), restrictions: ['Global qualification directory; workspace MCP diagnostics are separate.', 'No native session or model turn was created.'], checkedAt: new Date().toISOString() })
      } finally { await manager.shutdown() }
    }
    const manager = new OpenCodeNativeSessionManager({ server: new ManagedOpenCodeServer({
      binary: this.openCodeBinary, workingDirectory: this.directory, ownerAgentId: 'catalog-inspection',
    }), ownerAgentId: 'catalog-inspection' })
    try {
      const options = await manager.discoverOptions(this.directory, signal)
      return HarnessOptionsResultSchema.parse({ harness, ...options, settings: harnessSettingSupport(harness),
        restrictions: ['Only connected providers are selectable.', 'An empty variant selects the native default.', 'No native session or model turn was created.'], checkedAt: new Date().toISOString() })
    } finally { await manager.dispose() }
  }
}
