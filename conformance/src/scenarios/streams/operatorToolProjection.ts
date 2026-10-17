import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { ActivityItem, OperatorActivity, OperatorConversationState, WorkRef } from '@foreman-code/contracts'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import type { NormalizationRule } from '../../assertions.js'

/** Each result is independently asserted by the scenario before it becomes an activity expectation. */
export interface ExpectedOperatorToolCall {
  name: string
  arguments: Record<string, unknown>
  result: unknown
  additionalText?: readonly string[]
}

function expectedActivity(call: ExpectedOperatorToolCall, requestId: string, index: number): OperatorActivity {
  const text = JSON.stringify(call.result)
  assert.equal(typeof text, 'string', 'The expected native result must be complete JSON.')
  const input = JSON.stringify(call.arguments, null, 2)
  const output = JSON.stringify([{ type: 'inputText', text },
    ...(call.additionalText ?? []).map(value => ({ type: 'inputText', text: value }))], null, 2)
  return { id: '<id>', requestId, kind: 'tool', title: call.name.slice(0, 240), status: 'completed',
    input: input.slice(0, 16_000), output: output.slice(0, 24_000),
    ...(input.length > 16_000 || output.length > 24_000 ? { truncated: true } : {}),
    sequence: String(index * 2 + 1), revision: 2 }
}

export function expectedOperatorTools(state: OperatorConversationState, calls: readonly ExpectedOperatorToolCall[],
  owner: Extract<WorkRef, { kind: 'chat_request' }>, sessionId: string) {
  const observed = state.activities
  assert.ok(observed, 'The complete public activity list must be present.')
  assert.equal(observed.length, calls.length, 'Native tool activity must match the scenario’s complete call sequence.')
  const activities: OperatorActivity[] = []
  const items: ActivityItem[] = []
  const rules: NormalizationRule[] = []
  calls.forEach((call, index) => {
    const nativeId = observed[index]!.id
    assert.match(nativeId, /^conformance-native-[1-9][0-9]*-[1-9][0-9]*$/)
    const activity = expectedActivity(call, owner.requestId, index)
    activities.push(activity)
    rules.push({ pointer: `/body/activities/${index}/id`, kind: 'id' })
    items.push({ id: JSON.stringify(['conversation-activity', owner.conversationId, owner.requestId, nativeId]),
      revision: '2', order: activity.sequence, orderSource: 'conversation_activity', owner,
      native: { harness: 'codex', sessionId, turnId: 'turn-1', itemId: nativeId },
      source: { schemaVersion: 1, system: 'conversation_record', observedAt: null }, evidence: 'confirmed',
      kind: 'tool', toolKind: 'tool', title: activity.title, status: 'completed' })
  })
  return { activities, items, rules }
}

export function expectedOperatorPublications(calls: readonly ExpectedOperatorToolCall[]) {
  const receipts = new Map<string, { receiptId: string; value: ReturnType<typeof AgentFilePublishResultSchema.parse>['value'] }>()
  for (const call of calls) {
    if (call.name !== 'files_publish_result') continue
    const input = AgentFilePublishInputSchema.parse(call.arguments)
    const result = AgentFilePublishResultSchema.parse(call.result)
    const receiptId = `fil05:publish:${createHash('sha256').update(input.commandId).digest('hex')}`
    const previous = receipts.get(receiptId)
    if (previous) assert.deepStrictEqual(result, { value: previous.value, replayed: true })
    else {
      assert.equal(result.replayed, false)
      receipts.set(receiptId, { receiptId, value: result.value })
    }
  }
  return [...receipts.values()].sort((left, right) => left.receiptId.localeCompare(right.receiptId))
}
