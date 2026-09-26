import type { ExecutionResult } from '@graphql/contracts'
import { AcceptedCurrentNodeResultSchema, parseChoiceResultEnvelope, type WorkflowChoice, type ChoiceResultEnvelope } from '@graphql/contracts/wave25'

/** Parsing-only view of the exact Codex/OpenCode final-text carrier. Bound the
 * original result here so durable record rechecks can use the same policy without
 * rewriting stored evidence, accepted digests or inputs. Mixed carriers stay invalid.
 */
export function parseWorkflowChoiceResult(result: ExecutionResult, choice: WorkflowChoice): ChoiceResultEnvelope {
  AcceptedCurrentNodeResultSchema.parse(result)
  const output = result.outcome === 'succeeded' ? result.output : undefined
  if (output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string') {
    return parseChoiceResultEnvelope({ ...result, output: output.text }, choice)
  }
  return parseChoiceResultEnvelope(result, choice)
}
