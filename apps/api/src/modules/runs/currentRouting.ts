import type { ExecutionResult } from '@graphql/contracts'
import {
  AcceptedCurrentNodeResultSchema, WorkflowChoiceSchema, parseChoiceResultEnvelope,
  type WorkflowChoice, type ChoiceResultEnvelope,
} from '@graphql/contracts/wave25'

/** Parsing-only native text view; the complete original result remains the
 * accepted/digested evidence. No prefix salvage, Markdown or mixed carriers. */
export function parseCurrentChoiceResult(result: ExecutionResult, choice: WorkflowChoice): ChoiceResultEnvelope {
  AcceptedCurrentNodeResultSchema.parse(result)
  const output = result.outcome === 'succeeded' ? result.output : undefined
  if (output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string') {
    return parseChoiceResultEnvelope({ ...result, output: output.text }, choice)
  }
  return parseChoiceResultEnvelope(result, choice)
}

/** Request-only instructions derived from the immutable node. Never mutate the
 * saved configuration, accepted input, model settings, or routing authority. */
export function currentInitialPrompt(node: { initialPrompt?: string | undefined; choice?: WorkflowChoice | undefined }, repeatExit = false,
  handoff = false): string | undefined {
  if (handoff) {
    const outcomes = node.choice ? WorkflowChoiceSchema.parse(node.choice).outcomes.map(({ outcome }) => outcome) : []
    const contract = [
      'GraphQL work-handoff result contract (version 1)',
      'On successful completion, return exactly one complete JSON object with exactly routing and data.',
      'routing.kind is request, return, or finish.',
      `For a NEW work request, use {"kind":"request","outcome":<one of ${JSON.stringify(outcomes)}>}; only saved named outcomes are permitted.`,
      'For correlated feedback, use {"kind":"return","requestId":<the exact request ID in your received work>,"outcome":"accepted" or "needs_changes"}.',
      'To finish this activation, use {"kind":"finish"}; include a declared outcome when selecting a final downstream branch. Include unresolved findings honestly.',
      'data has exactly latestDeliverable (a non-null JSON value) and remainingFindings (an array of JSON values).',
      'Do not invent request IDs, connection IDs, destinations, approval outcomes or permissions. The backend validates saved routes.',
      'Do not wrap JSON in Markdown, commentary or partial output. The complete result must be at most 65536 UTF-8 bytes.',
      'End GraphQL work-handoff result contract.',
    ].join('\n')
    return node.initialPrompt ? `${node.initialPrompt}\n\n${contract}` : contract
  }
  if (!node.choice) return node.initialPrompt
  const choice = WorkflowChoiceSchema.parse(node.choice)
  // The schema bounds this list to 16 unique, injection-free names of <=48 chars.
  // Targets remain private backend authority: no relationship IDs are supplied.
  const outcomes = choice.outcomes.map(({ outcome }) => outcome)
  const contract = [
    'GraphQL finite-choice output contract (version 1)',
    `Allowed routing.outcome values: ${JSON.stringify(outcomes)}`,
    'On successful completion, return exactly one complete JSON object with exactly two keys: routing and data.',
    'routing must be an object with exactly one key, outcome, whose value is one of the allowed strings above.',
    repeatExit
      ? 'data must be an object with exactly latestDeliverable (a non-null JSON value) and remainingFindings (an array of JSON values). Preserve the latest deliverable and any unresolved findings on both exit outcomes.'
      : 'data must be a JSON value and may be null. Do not add keys to routing or to the outer object.',
    'Do not wrap the result in Markdown, code fences, commentary, or a string containing partial JSON.',
    'The entire JSON result must be at most 65536 UTF-8 bytes.',
    'Select an outcome only. Do not return edge IDs, successor IDs, or an execution plan; the backend resolves the saved targets.',
    `Envelope example (shape only, not a preferred outcome): ${JSON.stringify({ routing: { outcome: outcomes[0] }, data: repeatExit ? { latestDeliverable: {}, remainingFindings: [] } : null })}`,
    'End GraphQL finite-choice output contract.',
  ].join('\n')
  return node.initialPrompt ? `${node.initialPrompt}\n\n${contract}` : contract
}
