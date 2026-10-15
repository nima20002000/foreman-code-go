import { z } from 'zod'

/** Whether trying again can help: `transient` can, `permanent` cannot, `cancelled` was asked to stop. */
export const FailureClassSchema = z.enum(['transient', 'permanent', 'cancelled'])
export type FailureClass = z.infer<typeof FailureClassSchema>

/** The one failure shape every boundary (device channel, relay, MCP and HTTP replies, execution retries) keeps.
 * Its cause chain is the error's own `cause`, which `failureClass` walks. */
export interface Failure {
  code: string
  class: FailureClass
}

const retryableClass = (value: unknown): FailureClass | undefined =>
  typeof value === 'boolean' ? value ? 'transient' : 'permanent' : undefined

/** The class one error states about itself: `class`, or the older `retryable` flags on the error, its execution
 * result or its details. Undefined when it states none, so a code table may decide. */
export function explicitFailureClass(error: unknown): FailureClass | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const stated = error as {
    class?: unknown; retryable?: unknown; result?: { error?: { retryable?: unknown } }; details?: { retryable?: unknown }
  }
  const parsed = FailureClassSchema.safeParse(stated.class)
  if (parsed.success) return parsed.data
  return retryableClass(stated.retryable) ?? retryableClass(stated.result?.error?.retryable)
    ?? retryableClass(stated.details?.retryable)
}

/** Walks the cause chain once. At each link an explicit class wins over `byLink` (a code table); the first decision
 * ends the walk, and `last` decides when no link did. A cycle is permanent. */
export function failureClass(
  error: unknown,
  byLink: (link: object) => FailureClass | undefined,
  last: (link: unknown) => FailureClass = () => 'permanent',
): FailureClass {
  const seen = new Set<object>()
  while (typeof error === 'object' && error !== null) {
    if (seen.has(error)) return 'permanent'
    seen.add(error)
    const decided = explicitFailureClass(error) ?? byLink(error)
    if (decided) return decided
    const cause = (error as { cause?: unknown }).cause
    if (typeof cause !== 'object' || cause === null) break
    error = cause
  }
  return last(error)
}
