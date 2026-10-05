import type { OpenCodeHarnessConfiguration } from '@foreman-code/contracts'
import type { FileMcpService } from '../../files/tools/mcp.js'
import type { FileToolContext } from '../../files/tools/types.js'
import type { OpenCodeServerController } from '../opencodeTransport.js'
import { createOpenCodeFileMcpFacade } from './facade.js'
import { OpenCodeFileTurn, type PreparedOpenCodeFiles } from './turn.js'
import { checkFileCondition, OpenCodeFileCleanupError, type AcceptedOpenCodeFileTurn, type OpenCodeAcceptedFileReader,
  type OpenCodeFileTurnOptions } from './types.js'

/** The manager supplies all native fields. The resolver uses the durable accepted
 * chat command, not current Board state, file-tool arguments, or a browser path.
 */
export interface OpenCodeChatFileIdentity {
  ownerAgentId: string
  nativeSessionId: string
  nativeTurnId: string
  clientCorrelationId: string
  directory: string
  configuration: OpenCodeHarnessConfiguration
}

export interface OpenCodeChatFileBinding {
  admission: AcceptedOpenCodeFileTurn
  read: OpenCodeAcceptedFileReader
  options: Omit<OpenCodeFileTurnOptions, 'server' | 'appMcpServerName' | 'adoptPublished' | 'rememberCredential'>
  /** Idempotently adopt FIL-05's durable publication ledger into the exact
   * originating message, including lost publish acknowledgements. The operation
   * must check owner/scope/session/turn/message together and work after revoke.
   */
  adoptPublished(context: FileToolContext): Promise<void>
  /** Dedicated file-only listener, or an exact-token registry entry. Must install
   * the supplied facade without unknown-token fallback. Mounting the listener
   * grants no file authority: discovery connects before submission; file calls
   * wait for an acknowledged native prompt and a scoped file-session credential.
   * Return an idempotent unmount function; failures must leave a retryable fence.
   */
  mount(service: FileMcpService): Promise<() => Promise<void>>
}

export interface OpenCodeChatFiles {
  /** Reclaim registered materializations only after their original native process is confirmed closed. */
  recover?(signal: AbortSignal, retainedTurnIds: ReadonlySet<string>): Promise<void>
  /** Return undefined only when the accepted turn has no file-tool context.
   * Agent turns need a context for inherited references even without attachments.
   * An unavailable reader/host/listener for a file-enabled turn must THROW.
   */
  resolve(identity: OpenCodeChatFileIdentity, signal: AbortSignal): Promise<OpenCodeChatFileBinding | undefined>
}

/** Retained by the native OwnedTurn, not by an SSE subscription. */
export class OpenCodeManagedFileTurn {
  private unmounted = false
  constructor(
    readonly bridge: OpenCodeFileTurn,
    readonly inputs: PreparedOpenCodeFiles,
    private readonly unmount: () => Promise<void>,
    readonly nativeTurnId: string,
  ) {}

  private async close(operation: () => Promise<void>): Promise<void> {
    const errors: unknown[] = []
    let released: boolean
    try {
      await operation()
      released = true
    } catch (error) {
      released = error instanceof OpenCodeFileCleanupError
      errors.push(error)
    }
    if (!this.unmounted) {
      try { await this.unmount(); this.unmounted = true } catch (error) { errors.push(error) }
    }
    if (errors.length) {
      if (released) throw new OpenCodeFileCleanupError(errors)
      throw new AggregateError(errors, 'OpenCode chat file cleanup needs retry.')
    }
  }

  finish(evidence: 'terminal' | 'definite_rejection', signal: AbortSignal): Promise<void> {
    return this.close(() => this.bridge.finish(evidence, signal))
  }

  nativeProcessClosed(signal: AbortSignal): Promise<void> {
    return this.close(() => this.bridge.nativeProcessClosed(signal))
  }

  retryCleanup(signal: AbortSignal): Promise<void> {
    return this.close(() => this.bridge.retryCleanup(signal))
  }
}

export async function prepareOpenCodeChatFiles(runtime: OpenCodeChatFiles,
  identity: OpenCodeChatFileIdentity, server: OpenCodeServerController, appMcpServerName: string,
  signal: AbortSignal, rememberCredential?: (token: string) => void): Promise<OpenCodeManagedFileTurn | undefined> {
  const binding = await runtime.resolve(structuredClone(identity), signal)
  if (!binding) return undefined
  // Freeze the accepted identity before passing anything to external capabilities.
  const admission = structuredClone(binding.admission)
  const context = admission.context
  checkFileCondition(context.nativeSessionId === identity.nativeSessionId && context.turnId === identity.nativeTurnId
    && typeof context.messageId === 'string' && context.messageId.length > 0
    && admission.directory === identity.directory,
  'FILE_CONTEXT_DENIED', 'The file admission belongs to another native chat turn or directory.')
  const chat = context.scope.chat
  checkFileCondition(typeof context.ownerPrincipalId === 'string' && context.ownerPrincipalId.length > 0
    && (chat.kind === 'agent' ? chat.agentId === identity.ownerAgentId
      : chat.operatorId === identity.ownerAgentId && chat.ownerPrincipalId === context.ownerPrincipalId),
  'FILE_CONTEXT_DENIED', 'The file admission belongs to another chat owner.')
  // Do not override native permission/agent policy to make working copies possible.
  // The admission resolver must additionally validate the full accepted security configuration.
  checkFileCondition(identity.configuration.nativeAgent !== 'plan' || admission.mode === 'read',
    'FILE_SECURITY_CONFLICT', 'A native plan session cannot acquire file mutation authority.')
  const bridge = new OpenCodeFileTurn({ ...binding.options, server, appMcpServerName,
    ...(rememberCredential ? { rememberCredential } : {}),
    adoptPublished: (accepted) => binding.adoptPublished(accepted) })
  const unmount = await binding.mount(createOpenCodeFileMcpFacade(binding.options.service, () => bridge))
  try {
    const inputs = await bridge.prepareInputs(admission, binding.read, signal)
    return new OpenCodeManagedFileTurn(bridge, inputs, unmount, identity.nativeTurnId)
  } catch (error) {
    const errors: unknown[] = [error]
    try { await bridge.retryCleanup(AbortSignal.timeout(10_000)) } catch (cleanup) { errors.push(cleanup) }
    try { await unmount() } catch (cleanup) { errors.push(cleanup) }
    if (errors.length > 1) throw new AggregateError(errors, 'OpenCode chat file preparation needs cleanup.', { cause: error })
    throw error
  }
}
