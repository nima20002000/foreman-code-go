import type { AgentFileToolService } from '../../files/tools/service.js'
import type { FileToolContext } from '../../files/tools/types.js'
import type { FileRevision, MessageAttachmentRef } from '@graphql/contracts/files'
import type { OpenCodeServerController } from '../opencodeTransport.js'

/** The authenticated, persisted admission supplies this. It is NOT an HTTP/tool input. */
export interface AcceptedOpenCodeFileTurn {
  context: FileToolContext
  attachments: readonly MessageAttachmentRef[]
  expiresAt: Date
  /** The launcher's execution-host identity, never inferred from an API filesystem path. */
  executionHostId: string
  directory: string
  /** Must agree with the accepted harness configuration. This cannot elevate allowMutation. */
  mode: 'read' | 'write'
}

export interface OpenCodeRegisteredFile {
  handle: string
  executionHostId: string
  path: string
}

/** Implement on the execution host. No method receives an arbitrary model-supplied path.
 * The launcher must isolate the complete API byte vault, including unselected references.
 * assertSourceIsolation must also cover its ancestors and run as the native OS identity.
 */
export interface OpenCodeExecutionFiles {
  readonly executionHostId: string
  assertSourceIsolation(signal: AbortSignal): Promise<void>
  materialize(input: {
    handle: string
    revision: FileRevision
    bytes: Uint8Array
    writable: boolean
  }, signal: AbortSignal): Promise<OpenCodeRegisteredFile>
  /** A bounded, detached, stable snapshot of a registered handle, never a path argument. */
  snapshot(handle: string, signal: AbortSignal): Promise<Uint8Array>
  remove(handle: string): Promise<void>
}

export type OpenCodeFileService = Pick<AgentFileToolService,
  'sessions' | 'artifacts' | 'list' | 'read' | 'createWorkingCopy' | 'publish' | 'publishedForTurn'>

/** A trusted admission-bound range reader. It reauthorizes the owner/scope and
 * pinned revision on every call without minting a native file-tool credential.
 * It must not be implemented by issueForAcceptedSession before native ack.
 */
export type OpenCodeAcceptedFileReader = (
  input: MessageAttachmentRef & { offset: number; length: number },
  signal: AbortSignal,
) => ReturnType<AgentFileToolService['read']>

export type OpenCodeFilePart = {
  type: 'file'
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  filename: string
  url: string
}

export interface OpenCodeFileTurnOptions {
  service: OpenCodeFileService
  host: OpenCodeExecutionFiles
  server: OpenCodeServerController
  /** Server-side endpoint reachable FROM the execution host. Never use a browser-supplied URL. */
  endpoint: string
  appMcpServerName: string
  /** FIL-03/contract constants are supplied by the composition root. */
  maxFileBytes: number
  maxAttachments: number
  /** Trusted, idempotent repository operation: read FIL-05 publications for this
   * exact binding and adopt them into context.messageId. No destination is taken
   * from a tool result. Must remain usable after credential revocation/expiry.
   */
  adoptPublished?: (context: FileToolContext) => Promise<void>
  /** Manager-owned redaction registry only; never a logger or model callback. */
  rememberCredential?: (token: string) => void
}

export class OpenCodeFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OpenCodeFileError'
  }
}

export function checkFileCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new OpenCodeFileError(code, message)
}
