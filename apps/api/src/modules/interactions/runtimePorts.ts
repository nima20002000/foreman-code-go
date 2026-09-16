import type { AgentHarness, DurableInteraction, NativeSessionReference } from '@graphql/contracts'

import type { ChildProcessEnvironment, NativeHarnessSessionManager } from '../harnesses/port.js'

export interface NativeManagerResolutionContext {
  harness: AgentHarness
  executionId: string
  agentId: string
  workingDirectory: string
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
        || existing.context.workingDirectory !== context.workingDirectory) {
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
}

export interface ExecutionLaunchCredential {
  principalId: string
  environment: ChildProcessEnvironment
  expiresAt: string
}

/** Structurally compatible with HAP-04 WorkerLaunchCredentialService. */
export interface ExecutionCredentialProvider {
  prepare(input: {
    executionId: string
    harness: AgentHarness
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<{ credential: ExecutionLaunchCredential; detection: unknown }>
  revokeForExecution(executionId: string): Promise<number>
}

export interface AttachedInteractionSession {
  manager: NativeHarnessSessionManager
  session: NativeSessionReference
}

export interface InteractionNativeRuntime {
  attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession>
  attachOwnedSession(
    context: NativeManagerResolutionContext,
    session: NativeSessionReference,
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession>
}
