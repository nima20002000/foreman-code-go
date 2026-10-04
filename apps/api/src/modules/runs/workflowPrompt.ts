import { WorkflowChoiceSchema, type WorkflowChoice, type RepeatBlockV1 } from '@foreman-code/contracts/wave25'

/** Request-only instructions derived from the immutable node. Never mutate the
 * saved configuration, accepted input, model settings, or routing authority. */
export function workflowInitialPrompt(node: { initialPrompt?: string | undefined; choice?: WorkflowChoice | undefined }, repeatExit?: Pick<RepeatBlockV1, 'repeatOutcome' | 'earlyExitOutcome'>): string | undefined {
  if (!node.choice) return node.initialPrompt
  const choice = WorkflowChoiceSchema.parse(node.choice)
  // The schema bounds this list to 16 unique, injection-free names of <=48 chars.
  // Targets remain private backend authority: no relationship IDs are supplied.
  const outcomes = choice.outcomes.map(({ outcome }) => outcome)
  const contract = [
    'Foreman Code finite-choice output contract (version 1)',
    `Allowed routing.outcome values: ${JSON.stringify(outcomes)}`,
    'On successful completion, return exactly one complete JSON object with exactly two keys: routing and data.',
    'routing must be an object with exactly one key, outcome, whose value is one of the allowed strings above.',
    repeatExit
      ? 'data must be an object with exactly latestDeliverable and remainingFindings. latestDeliverable must be a non-null JSON value; remainingFindings must be an array of JSON values. Preserve the latest deliverable and unresolved findings even when more work remains.'
      : 'data must be a JSON value and may be null. Do not add keys to routing or to the outer object.',
    'Do not wrap the result in Markdown, code fences, commentary, or a string containing partial JSON.',
    'The entire JSON result must be at most 65536 UTF-8 bytes.',
    'Select an outcome only. Do not return edge IDs, successor IDs, or an execution plan; the backend resolves the saved targets.',
    `Envelope example (shape only, not a preferred outcome): ${JSON.stringify({ routing: { outcome: outcomes[0] }, data: repeatExit ? { latestDeliverable: {}, remainingFindings: [] } : null })}`,
    'End Foreman Code finite-choice output contract.',
  ].join('\n')
  return node.initialPrompt ? `${node.initialPrompt}\n\n${contract}` : contract
}
