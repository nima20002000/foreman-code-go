/** Review-only policy, applied AFTER the adapter's rooted, idle, pending-free
 * scan and raw-source validation. Ordinary workflow ExecutionResult semantics
 * are deliberately unchanged. An accepted application decision is necessary
 * for delivery, but is not proof that truncated/filtered native output succeeded.
 * The saved review contract has no stronger-success exception for those finishes.
 */
export function openCodeReviewTerminalOutcome(value: unknown): 'succeeded' | 'failed' | undefined {
  const info = object(value), time = object(info.time)
  if (info.role !== 'assistant' || info.summary === true
    || typeof time.completed !== 'number' || !Number.isFinite(time.completed)) return undefined
  if (info.error) return 'failed'
  if (info.finish === 'stop') return 'succeeded'
  if (info.finish === 'length' || info.finish === 'content-filter') return 'failed'
  // Tool-calls, unknown/new finish reasons and incomplete metadata are not
  // settlement proof. Retain uncertainty; never infer success from idle or text.
  return undefined
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
