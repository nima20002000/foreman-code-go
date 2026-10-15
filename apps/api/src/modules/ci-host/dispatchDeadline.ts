import { waitForCiDispatch, withCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'

export const CI_DISPATCH_PASS_MS = 3000

/** Expired passes cannot acquire another connection or enter another executor request. */
export async function withCiDispatchDeadline(work: () => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('CI dispatch pass timed out; retrying.')), CI_DISPATCH_PASS_MS)
  timer.unref()
  try {
    await withCiDatabasePriority(() => waitForCiDispatch(work), controller.signal)
  } finally {
    clearTimeout(timer)
    controller.abort(new Error('CI dispatch pass ended.'))
  }
}
