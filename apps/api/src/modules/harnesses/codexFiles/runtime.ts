import { createHash } from 'node:crypto'
import { ZodError } from 'zod'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { componentLogger } from '../../diagnostics/logger.js'
import type { CodexFileCall, CodexFileCallResult } from './port.js'
import type { CodexFileTurn } from './turn.js'

export type PreparedCodexFileTurn = Pick<CodexFileTurn,
  'allowedTools' | 'nativeInput' | 'activate' | 'call' | 'publications' | 'close'>

/** Installed only on a chat-owned manager. Resolve a persisted admission by this
 * exact conversation's native session + correlation; never by the open Board.
 * undefined means a positively identified text-only admission, not a lookup error.
 * Host leases and authenticated attachment readers are supplied by composition. */
export interface CodexChatFiles {
  prepare(input: {
    session: NativeSessionReference
    clientCorrelationId: string
    signal: AbortSignal
  }): Promise<PreparedCodexFileTurn | undefined>
}

const MAX_CALLS = 128
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_RETAINED_BYTES = 8 * 1024 * 1024
const refused = (): CodexFileCallResult => ({ success: false,
  contentItems: [{ type: 'inputText', text: 'File operation unavailable or denied.' }],
})
const log = componentLogger('harness')
function errorIdentity(error: unknown) {
  const value = error && typeof error === 'object' ? error as { code?: unknown; constructor?: { name?: unknown } } : undefined
  const safe = (part: unknown) => typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(part) ? part : undefined
  const code = safe(value?.code), className = safe(value?.constructor?.name)
  const validation = error instanceof ZodError ? error.issues.slice(0, 8).map(issue => ({
    code: issue.code,
    path: issue.path.slice(0, 8).filter(part => typeof part === 'number' || safe(part)),
  })) : undefined
  return { ...(code ? { code } : {}), ...(className ? { class: className } : {}),
    ...(validation ? { validation } : {}) }
}
export function warnCodexFileError(error: unknown): void {
  log.warn(errorIdentity(error), 'Codex file operation failed')
}
function identity(value: unknown): string {
  const sorted = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sorted)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)])) : entry
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
}

/** Local executable registration, separate from Codex's thread-level schema
 * declarations. There is deliberately no invented native register-tools RPC.
 * Tokens remain private inside the existing FIL-08 bridge. */
export class CodexRuntimeFileTurn {
  private nativeTurnId: string | undefined
  private closing = false
  private registered = false
  private readonly calls = new Map<string, { signature: string; result: Promise<CodexFileCallResult> }>()
  private retainedBytes = 0

  constructor(readonly bridge: PreparedCodexFileTurn, private readonly threadId: string) {}

  get closed(): boolean { return this.closing }

  async activate(nativeTurnId: string): Promise<void> {
    if (this.closing) throw new Error('CODEX_FILE_TURN_CLOSED')
    if (this.nativeTurnId && this.nativeTurnId !== nativeTurnId) throw new Error('CODEX_FILE_TURN_MISMATCH')
    this.nativeTurnId = nativeTurnId
    await this.bridge.activate(nativeTurnId)
    // close() can race asynchronous token issuance. The bridge revokes even a
    // token issued during close; this handler must never become live afterwards.
    if (this.closing) { await this.bridge.close(); return }
    this.registered = true
  }

  dispatch(request: CodexFileCall & { callId: string }): Promise<CodexFileCallResult> {
    // Check ownership BEFORE consulting receipts, including repeated call IDs.
    if (!this.registered || this.closing || request.threadId !== this.threadId
      || request.turnId !== this.nativeTurnId || !request.callId.trim()
      || request.callId.length > 1_024) return Promise.resolve(refused())
    const signature = identity(request)
    const prior = this.calls.get(request.callId)
    if (prior) return prior.signature === signature ? prior.result : Promise.resolve(refused())
    if (this.calls.size >= MAX_CALLS || this.retainedBytes >= MAX_RETAINED_BYTES) return Promise.resolve(refused())
    // Publish/copy cannot run twice on an early retransmission with a different
    // JSON-RPC request ID. FIL-05 command receipts still own durable idempotency.
    const result = Promise.resolve().then(() => this.closing ? refused() : this.bridge.call(request))
      .then((value) => {
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (bytes > MAX_RESPONSE_BYTES || this.retainedBytes + bytes > MAX_RETAINED_BYTES) return refused()
        this.retainedBytes += bytes
        return value
      }, (error: unknown) => { warnCodexFileError(error); return refused() })
    this.calls.set(request.callId, { signature, result })
    return result
  }

  close(): Promise<void> {
    this.closing = true
    this.registered = false
    // Revocation is requested synchronously, before waiting for calls/host cleanup.
    // Failed cleanup is retryable through the existing bridge's close contract.
    return this.bridge.close()
  }
}
