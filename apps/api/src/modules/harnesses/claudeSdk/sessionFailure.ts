import type { ClaudeManagerContext, Runtime } from './sessionTypes.js'
import { record } from './sessionState.js'

/** A failed publication and a failed native stream share the same owned runtime cleanup. */
export async function failRuntime(ctx: ClaudeManagerContext, runtime: Runtime, error: unknown): Promise<void> {
  runtime.failure = error
  runtime.closed = true
  delete runtime.httpCredentialAcknowledgement
  await record(ctx, runtime, 'claude.session.failed', {
    nativeSessionId: runtime.session?.nativeSessionId,
    error: { code: 'CLAUDE_NATIVE_STREAM_ERROR',
      message: error instanceof Error ? error.message : 'The native Claude query failed.' },
  })
  runtime.rejectInit(error)
  runtime.active?.events.close(error)
  await runtime.sdk.close()
}
