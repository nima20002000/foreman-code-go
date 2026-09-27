import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { AgentChatStateSchema } from '@graphql/contracts/agent-chat'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'

/** These state-only tests must not launch a native process, read a Run, or touch SQL. */
function service() {
  type Ports = ConstructorParameters<typeof AgentChatService>
  const forbidden = () => { throw new Error('Unexpected I/O while describing an unopened chat.') }
  return new AgentChatService({ query: forbidden } as unknown as Ports[0], {} as Ports[1], {} as Ports[2],
    { getSavedVersion: forbidden, getCurrentSavedVersion: forbidden, getAgentConfiguration: forbidden },
    { getForWorkspace: forbidden, executionPages: forbidden }, forbidden, '/h2-not-used')
}

describe('H2 A-R01: truthful chat availability without changing the frozen contract', () => {
  for (const harness of ['codex', 'opencode'] as const) {
    it(`${harness}: an unopened chat states the workflow-tool restriction without blocking ordinary chat`, async () => {
      const fixture = makeCurrentWorkflowFixture('h2-state', 'single')
      const configuration = structuredClone(fixture.configurations[0]!)
      if (harness === 'opencode') configuration.harness = { harness, model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: false }
      const context = { workspaceId: configuration.workspaceId, workflowId: fixture.scope.workflowId,
        workflowNodeId: fixture.version.definition.nodes[0]!.id, agentId: configuration.agentId }
      const chat = service()
      try {
        const state = await chat['state']({ context, configuration })
        assert.equal(AgentChatStateSchema.safeParse(state).success, true)
        assert.equal(state.availability.canSend, true)
        assert.match(state.availability.message!, /GraphQL workflow tools are not available in chat/)
        assert.match(state.availability.message!, /other accepted Agent settings are retained/)
        assert.equal(state.availability.reason, undefined)
        assert.equal(state.capabilities.harness, harness)
        assert.equal(state.capabilities.resume, true)
        assert.equal(state.capabilities.steer, harness === 'codex' ? 'native_expected_turn' : 'unavailable')
        assert.equal(state.conversation, null)
        assert.equal(state.sessionState, 'none')
        const blocked = await chat['state']({ context, configuration, blocked: { reason: 'run_active', message: 'The Run is still active.' } })
        assert.deepEqual(blocked.availability, { canSend: false, reason: 'run_active', message: 'The Run is still active.' })
      } finally { await chat.shutdown() }
    })
  }
})
