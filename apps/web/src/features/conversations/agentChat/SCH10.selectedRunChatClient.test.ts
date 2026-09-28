import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ReadSelectedRunChatResponseSchema } from '@graphql/contracts/selected-run-chat'
import { server } from '../../../mocks/server'
import { selectedRunChatApi, selectedRunChatPath } from './selectedRunChatClient'
import { resolvedSelectedChatKey } from './selectedRunChatModel'
import { admitted, envelope, execution, historicalState, selectedRoute } from './sch10.testSupport'

describe('SCH-06 browser boundary', () => {
  it('requests the exact historical execution and rejects a neighboring Run', async () => {
    let url = ''
    server.use(http.get(selectedRoute, ({ request }) => { url = request.url; return HttpResponse.json(envelope(historicalState('run-a'))) }))
    const result = await selectedRunChatApi.read(execution('run-a'))
    expect(result.kind).toBe('selected')
    expect(new URL(url).searchParams.get('executionId')).toBe('execution-run-a')
    expect(new URL(url).pathname).toBe(selectedRunChatPath(execution('run-a')))
    server.use(http.get(selectedRoute, () => HttpResponse.json(envelope(historicalState('run-b')))))
    await expect(selectedRunChatApi.read(execution('run-a'))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('sends through the historical path with execution and preconditions, never a second context', async () => {
    const state = historicalState('run-a')
    const input = { requestId: 'send-a', context: { workflowId: state.context.workflowId, workflowNodeId: state.context.workflowNodeId,
      agentId: state.context.agentId, runId: 'run-a' }, content: 'Continue', intent: 'steer' as const,
      expectedConversationId: state.conversation!.id, expectedNativeTurnId: 'native-a' }
    let body: unknown
    server.use(http.post(`${selectedRoute}/messages`, async ({ request }) => {
      body = await request.json(); return HttpResponse.json(admitted(state, input))
    }))
    const result = await selectedRunChatApi.send(execution('run-a'), input)
    expect(result.turn.requestId).toBe(input.requestId)
    expect(body).toEqual({ executionId: 'execution-run-a', requestId: input.requestId, content: 'Continue', intent: 'steer',
      expectedConversationId: state.conversation!.id, expectedNativeTurnId: 'native-a' })
  })

  it('interrupts through SCH-06 with the complete key, including Agent and conversation', async () => {
    const state = historicalState('run-a'), key = resolvedSelectedChatKey(execution('run-a'), state)!
    let body: unknown
    server.use(http.post(`${selectedRoute}/interrupt`, async ({ request }) => { body = await request.json(); return HttpResponse.json({ state }) }))
    await selectedRunChatApi.interrupt(key, { requestId: 'stop-a', expectedNativeTurnId: 'native-a' })
    expect(body).toEqual({ executionId: key.executionId, agentId: key.agentId, conversationId: key.conversationId,
      requestId: 'stop-a', expectedNativeTurnId: 'native-a' })
  })

  it('rejects a response whose conversation belongs to another execution before exposing it', async () => {
    const response = envelope(historicalState('run-a'))
    if (response.kind !== 'selected' || !response.state.conversation || response.state.conversation.origin.kind !== 'run_execution') throw new Error('fixture')
    response.state.conversation.origin.executionId = 'different-execution'
    expect(ReadSelectedRunChatResponseSchema.safeParse(response).success).toBe(false)
    server.use(http.get(selectedRoute, () => HttpResponse.json(response)))
    await expect(selectedRunChatApi.read(execution('run-a'))).rejects.toThrow()
  })
})
