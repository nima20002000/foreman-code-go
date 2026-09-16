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

export type NativeManagerLifecycle = 'allocated' | 'starting' | 'resident' | 'released' | 'failed'

export interface ResolvedNativeSessionManager {
  manager: NativeHarnessSessionManager
  /** True only when create/attach must start a new provider process. */
  readonly processState: 'resident' | 'needs_start'
  readonly lifecycle?: NativeManagerLifecycle
  /** Claim startup before credential preflight; allocation alone is not residency. */
  beginStart?(): void
  /** Called only after the provider successfully creates/attaches the exact session. */
  markResident?(): void
  /** Fence reuse while failed-process/credential cleanup is still running. */
  markFailed?(): void
}

/** Manager ownership is per durable Agent execution, never per harness singleton. */
export interface NativeSessionManagerResolver {
  resolve(context: NativeManagerResolutionContext): ResolvedNativeSessionManager
  release?(context: NativeManagerResolutionContext, manager?: NativeHarnessSessionManager, state?: 'released' | 'failed'): void
}

export class ExecutionScopedNativeSessionManagerResolver implements NativeSessionManagerResolver {
  private readonly entries = new Map<string, {
    context: NativeManagerResolutionContext
    manager: NativeHarnessSessionManager
    lifecycle: NativeManagerLifecycle
    resolved: ResolvedNativeSessionManager
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
      if (existing.lifecycle === 'failed') throw new Error('The failed native manager is being released.')
      return existing.resolved
    }
    const manager = this.create(context)
    if (manager.harness !== context.harness) throw new Error('The native manager factory returned the wrong harness.')
    const entry: {
      context: NativeManagerResolutionContext
      manager: NativeHarnessSessionManager
      lifecycle: NativeManagerLifecycle
      resolved: ResolvedNativeSessionManager
    } = {
      context, manager, lifecycle: 'allocated',
      resolved: {
        manager,
        get processState() { return entry.lifecycle === 'resident' ? 'resident' : 'needs_start' },
        get lifecycle() { return entry.lifecycle },
        beginStart: () => {
          if (this.entries.get(context.executionId) !== entry || entry.lifecycle !== 'allocated') {
            throw new Error('The native manager is already starting, resident, or released.')
          }
          entry.lifecycle = 'starting'
        },
        markResident: () => {
          if (this.entries.get(context.executionId) !== entry
            || (entry.lifecycle !== 'starting' && entry.lifecycle !== 'resident')) {
            throw new Error('An unstarted or released native manager cannot become resident.')
          }
          entry.lifecycle = 'resident'
        },
        markFailed: () => {
          if (this.entries.get(context.executionId) === entry) entry.lifecycle = 'failed'
        },
      },
    }
    this.entries.set(context.executionId, entry)
    return entry.resolved
  }

  release(context: NativeManagerResolutionContext, manager?: NativeHarnessSessionManager, state: 'released' | 'failed' = 'released'): void {
    const current = this.entries.get(context.executionId)
    if (current && current.context.agentId === context.agentId && (!manager || current.manager === manager)) {
      current.lifecycle = state
      this.entries.delete(context.executionId)
    }
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
