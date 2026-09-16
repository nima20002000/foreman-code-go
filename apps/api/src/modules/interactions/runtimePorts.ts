import { isDeepStrictEqual } from 'node:util'

import type { AgentConfigurationVersion, AgentHarness, DurableInteraction, NativeSessionReference } from '@graphql/contracts'

import type { NativeHarnessSessionManager } from '../harnesses/port.js'

export interface NativeManagerOwnershipContext {
  harness: AgentHarness
  executionId: string
  agentId: string
  workingDirectory: string
}

export interface NativeManagerResolutionContext extends NativeManagerOwnershipContext {
  /** Immutable configuration version pinned by the durable execution. */
  configuration: AgentConfigurationVersion
}

export interface ResolvedNativeSessionManager {
  manager: NativeHarnessSessionManager
  /** True only when create/attach must start a new provider process. */
  processState: 'resident' | 'needs_start'
}

/** Manager ownership is per durable Agent execution, never per harness singleton. */
export interface NativeSessionManagerResolver {
  resolve(context: NativeManagerResolutionContext): ResolvedNativeSessionManager
  release?(context: NativeManagerResolutionContext): void
}

export class ExecutionScopedNativeSessionManagerResolver implements NativeSessionManagerResolver {
  private readonly entries = new Map<string, {
    context: NativeManagerResolutionContext
    manager: NativeHarnessSessionManager
  }>()

  constructor(private readonly create: (context: NativeManagerResolutionContext) => NativeHarnessSessionManager) {}

  resolve(context: NativeManagerResolutionContext): ResolvedNativeSessionManager {
    const existing = this.entries.get(context.executionId)
    if (existing) {
      if (existing.context.agentId !== context.agentId || existing.context.harness !== context.harness
        || existing.context.workingDirectory !== context.workingDirectory
        || !isDeepStrictEqual(existing.context.configuration, context.configuration)) {
        throw new Error('A durable execution cannot change native manager ownership context.')
      }
      return { manager: existing.manager, processState: 'resident' }
    }
    const manager = this.create(context)
    if (manager.harness !== context.harness) throw new Error('The native manager factory returned the wrong harness.')
    this.entries.set(context.executionId, { context, manager })
    return { manager, processState: 'needs_start' }
  }

  release(context: NativeManagerResolutionContext): void {
    const current = this.entries.get(context.executionId)
    if (current && current.context.agentId === context.agentId) this.entries.delete(context.executionId)
  }

  async dispose(): Promise<void> {
    const managers = [...this.entries.values()].map((entry) => entry.manager)
    this.entries.clear()
    await Promise.allSettled(managers.map(async (manager) => {
      const disposable = manager as NativeHarnessSessionManager & { dispose?: () => Promise<void> }
      await disposable.dispose?.()
    }))
  }
}

export interface AttachedInteractionSession {
  manager: NativeHarnessSessionManager
  session: NativeSessionReference
}

export interface InteractionNativeRuntime {
  attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession>
  attachOwnedSession(
    context: NativeManagerOwnershipContext,
    session: NativeSessionReference,
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession>
}
