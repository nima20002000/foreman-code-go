import { describe, expect, it } from 'vitest'
import { publicRunActivity, type ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const fixture = currentUnitSnapshot('native-activity')
const node = agentWorkflowNode(fixture.version.definition.nodes[0])
const row: ActivityReadRow = {
  sequence: '1', source: 'harness', kind: 'harness_output', occurred_at: new Date(fixture.createdAt),
  harness_execution_id: 'execution', execution_node_id: node.id, execution_agent_id: node.agentId,
  execution_attempt: 1, work_activation_id: null, result_outcome: null, safe_payload: {}, native: null,
}

describe('native Run activity status', () => {
  it.each(['canceled', 'cancelled', 'interrupted'])('keeps %s canceled across native envelopes', (status) => {
    for (const type of ['item.started', 'item.completed', 'item.snapshot']) {
      for (const fields of [{ itemType: 'commandExecution', itemStatus: status, itemError: true },
        { partTool: 'bash', partStatus: status }]) {
        const activity = publicRunActivity({ ...row, native: { type, ...fields } },
          fixture.version, fixture.run.id, fixture.run.outcome)
        expect(activity).toMatchObject({ kind: 'tool_action', status: 'canceled', severity: 'info',
          summary: 'Command action canceled' })
      }
    }
    const snapshot = projectNativeActivityFacts([{
      execution_id: 'execution', sequence: '1', item_id: 'command', item_type: 'commandExecution', status,
      native_session_id: 'session', native_turn_id: null, generation: null, observed_at: fixture.createdAt,
    }], () => ({ owner: { kind: 'run', ...fixture.scope }, harness: 'codex', sessionId: 'session', terminal: false }))
    expect(snapshot.activities[0]).toMatchObject({ status: 'canceled', evidence: 'confirmed' })
    expect(snapshot.active).toEqual([])
  })

  it.each([
    { itemStatus: 'completed', itemError: false, expected: 'completed' },
    { itemStatus: 'completed', itemError: true, expected: 'failed' },
    { itemStatus: 'failed', itemError: false, expected: 'failed' },
    { itemStatus: 'declined', itemError: false, expected: 'failed' },
  ])('preserves completion and real failures: $expected', ({ expected, ...native }) => {
    expect(publicRunActivity({ ...row, native: { type: 'item.completed', itemType: 'commandExecution', ...native } },
      fixture.version, fixture.run.id, fixture.run.outcome).status).toBe(expected)
  })
})
