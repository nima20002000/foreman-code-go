import { randomUUID } from 'node:crypto'

import type { HarnessConfiguration, HarnessQualification } from '@graphql/contracts'

import { CodexAppServerSessionManager } from './codexAppServer.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './opencodeServer.js'
import type { HarnessConfigurationQualifier } from './port.js'

/** Model-free discovery uses the actual native integrations, never a second execution transport. */
export class NativeHarnessConfigurationQualifier implements HarnessConfigurationQualifier {
  constructor(private readonly codexBinary: string, private readonly openCodeBinary: string) {}

  async qualify(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal): Promise<HarnessQualification> {
    if (configuration.harness === 'codex') {
      const manager = new CodexAppServerSessionManager(this.codexBinary)
      try { return await manager.qualifyConfiguration(configuration, workingDirectory, signal) }
      finally { await manager.shutdown() }
    }
    // Qualification owns an isolated native server. It receives no workflow or Operator credential.
    const ownerAgentId = `qualification-${randomUUID()}`
    const manager = new OpenCodeNativeSessionManager({
      ownerAgentId,
      server: new ManagedOpenCodeServer({
        binary: this.openCodeBinary, workingDirectory, ownerAgentId,
        ...(configuration.advanced ? { advancedConfiguration: configuration.advanced } : {}),
      }),
    })
    try { return await manager.qualifyConfiguration(configuration, workingDirectory, signal) }
    finally { await manager.dispose() }
  }
}
