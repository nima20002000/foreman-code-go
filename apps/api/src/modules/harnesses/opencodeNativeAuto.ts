import type { OpenCodeHarnessConfiguration } from '@foreman-code/contracts'

import { HarnessExecutionError } from './errors.js'

const MAX_AUTO_REPLY_IDENTITIES = 4_096

export function usesOpenCodeNativeAuto(configuration: OpenCodeHarnessConfiguration): boolean {
  return configuration.autoApprove || configuration.advanced?.permissionHandling === 'native_auto'
}

interface PermissionIdentity {
  id: string
  sessionID: string
}
interface ReplyRecord {
  sessionID: string
  failure?: HarnessExecutionError
}

/** Serialize authoritative reads with replies. Never replay an unconfirmed native mutation. */
export class OpenCodeNativeAutoReplies {
  private queue: Promise<unknown> = Promise.resolve()
  private controller = new AbortController()
  private readonly replies = new Map<string, ReplyRecord>()
  private pendingCount = 0

  get hasPending(): boolean { return this.pendingCount > 0 }
  get stopped(): boolean { return this.controller.signal.aborted }

  stop(): void { this.controller.abort() }

  /** A separately reserved new turn may use the session after native cancellation. */
  resume(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController()
    this.pendingCount = 0
  }

  consume(
    readOwned: (signal: AbortSignal) => Promise<readonly PermissionIdentity[]>,
    replyOnce: (request: PermissionIdentity, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<readonly PermissionIdentity[]> {
    // Capture this turn's cancellation generation before queuing. A later turn
    // must not revive an older queued permission response.
    const combined = AbortSignal.any([signal, this.controller.signal])
    const task = this.queue.then(async () => {
      combined.throwIfAborted()
      const pending = await readOwned(combined)
      combined.throwIfAborted()
      this.pendingCount = pending.length
      const submitted: PermissionIdentity[] = []
      for (const request of pending) {
        combined.throwIfAborted()
        const previous = this.replies.get(request.id)
        if (previous) {
          if (previous.sessionID !== request.sessionID) throw new HarnessExecutionError(
            'OPENCODE_NATIVE_AUTO_IDENTITY_CONFLICT', 'A native permission ID changed its owning session. No automatic response was sent.',
          )
          if (previous.failure) throw previous.failure
          continue
        }
        if (this.replies.size >= MAX_AUTO_REPLY_IDENTITIES) throw new HarnessExecutionError(
          'OPENCODE_NATIVE_AUTO_IDENTITY_LIMIT', 'The native auto reply history reached its safety limit. Start a new session; old reply identities were not discarded.',
        )
        const record: ReplyRecord = { sessionID: request.sessionID }
        // Claim before dispatch. A lost response is not permission to repeat it.
        this.replies.set(request.id, record)
        try {
          await replyOnce(request, combined)
        } catch {
          record.failure = new HarnessExecutionError(
            'OPENCODE_NATIVE_AUTO_REPLY_UNCONFIRMED', 'The native permission reply was not confirmed. It was not retried or converted into a routed approval; reconcile or stop the execution.',
          )
          throw record.failure
        }
        submitted.push(request)
      }
      combined.throwIfAborted()
      return submitted
    })
    this.queue = task.catch(() => undefined)
    return task
  }
}
