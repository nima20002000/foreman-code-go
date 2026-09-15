import type { AgentHarness } from '@graphql/contracts'

import { CodexAdapter } from './codex.js'
import { OpenCodeAdapter } from './opencode.js'
import type { HarnessAdapter, HarnessResolver } from './port.js'

export class LocalHarnessResolver implements HarnessResolver {
  private readonly adapters: Record<AgentHarness, HarnessAdapter>

  constructor(codexBinary: string, openCodeBinary: string) {
    this.adapters = {
      codex: new CodexAdapter(codexBinary),
      opencode: new OpenCodeAdapter(openCodeBinary),
    }
  }

  resolve(harness: AgentHarness): HarnessAdapter {
    return this.adapters[harness]
  }
}
