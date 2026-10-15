import type { ExecutionResult } from '@foreman-code/contracts'
import { WorkActivationInputSchema, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { ZodError } from 'zod'

/** Direct feedback must answer the request frozen in the received work. */
export function parseWorkResultForInput(result: ExecutionResult, input?: unknown) {
  const parsed = parseWorkHandoffResult(result)
  if (parsed.routing.kind !== 'return' || input === undefined) return parsed
  const { work } = WorkActivationInputSchema.parse(input)
  if (work.kind === 'work_request' && parsed.routing.requestId !== work.request.requestId) {
    throw new ZodError([{ code: 'custom', path: ['routing', 'requestId'],
      message: `Return requestId must match the received request: ${work.request.requestId}` }])
  }
  return parsed
}
