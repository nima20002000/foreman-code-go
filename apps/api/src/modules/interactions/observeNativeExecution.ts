import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'

/** After approval delivery, observe the already-running turn; never submit a second prompt. */
export async function observeNativeExecution(manager: NativeHarnessSessionManager, session: NativeSessionReference,
  correlationId: string, signal: AbortSignal, assertBudget: () => Promise<void>): Promise<NativeHistory> {
  while (true) {
    signal.throwIfAborted()
    await assertBudget()
    const history = await manager.reconcile(session, correlationId, signal)
    if (history.pendingInteractions.length || (history.correlationId === correlationId && history.terminalResult)) return history
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 100)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
