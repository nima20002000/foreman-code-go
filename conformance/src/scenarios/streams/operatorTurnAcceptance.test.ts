import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_DEFAULTS, type OperatorConversationState, type SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import type { PublicResponse } from '../../clients/http.js'
import { assertAcceptedOperatorTurn } from './operatorTurnState.js'

function acceptanceFixture() {
  const before: OperatorConversationState = {
    conversation: {
      id: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000002',
      operatorConfigurationVersionId: '00000000-0000-4000-8000-000000000003',
      scope: 'application', title: 'Acceptance diagnostics', status: 'open',
      createdAt: '2026-10-18T12:00:00.000Z', updatedAt: '2026-10-18T12:00:00.000Z',
    },
    messages: [], turnState: 'idle', revision: 0, activeRequestId: null,
  }
  const input: SendOperatorMessageRequest = {
    requestId: '00000000-0000-4000-8000-000000000004',
    configurationVersionId: before.conversation.operatorConfigurationVersionId!,
    content: 'Describe the completed work.',
  }
  const body = {
    replayed: false,
    state: {
      ...before,
      conversation: { ...before.conversation, updatedAt: '2026-10-18T12:00:01.000Z' },
      messages: [{
        id: '00000000-0000-4000-8000-000000000005',
        conversationId: before.conversation.id, role: 'user', requestId: input.requestId,
        content: input.content,
        acceptedModel: { harness: 'codex', model: DEFAULT_AGENT_DEFAULTS.operator.harness.model },
        revision: '0', sequence: '1',
        createdAt: '2026-10-18T12:00:01.000Z', updatedAt: '2026-10-18T12:00:01.000Z',
        originalInput: { requestId: input.requestId, content: input.content, attachments: [] },
      }],
      turnState: 'starting', revision: 1, activeRequestId: input.requestId,
    },
  }
  return { before, input, body }
}

function publicResponse(body: unknown, status = 202): PublicResponse {
  return { status, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }), body }
}

function thrownBy(action: () => unknown): Error {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof Error)
    return error
  }
  throw new Error('Expected the public acceptance assertion to reject the response')
}

describe('Operator turn acceptance validation', () => {
  it('reports the complete public HTTP error before accessing acceptance fields', () => {
    const { before, input } = acceptanceFixture()
    const body = { error: {
      code: 'INVALID_REQUEST', message: 'The request does not match its shared contract.',
      issues: [{ path: ['requiresResume'], message: 'ephemeral Codex sessions cannot support resume-dependent features' }],
    } }
    const response = publicResponse(body, 400)
    const original = structuredClone(body)
    const error = thrownBy(() => assertAcceptedOperatorTurn(response, before, input, []))
    const path = `/api/operator/conversations/${before.conversation.id}/messages`
    expect(error.name).toBe('PublicHttpResponseError')
    expect(error.message).toBe(`POST ${path} returned HTTP 400; expected HTTP 202 and SendOperatorMessageResponse.`)
    expect(error).toHaveProperty('details', {
      method: 'POST', path, status: 400, expectedStatus: 202, contract: 'SendOperatorMessageResponse',
      contentType: 'application/json', responseBodyPreview: JSON.stringify(original), responseBodyTruncated: false,
    })
    expect(response.body).toStrictEqual(original)
  })

  it('reports shared success-schema issues before normalizing a malformed HTTP 202 body', () => {
    const { before, input } = acceptanceFixture()
    const body = { replayed: false, state: {} }
    const response = publicResponse(body)
    const original = structuredClone(body)
    const error = thrownBy(() => assertAcceptedOperatorTurn(response, before, input, []))
    const path = `/api/operator/conversations/${before.conversation.id}/messages`
    expect(error.name).toBe('PublicHttpResponseError')
    expect(error.message).toBe(`POST ${path} returned HTTP 202; expected HTTP 202 and SendOperatorMessageResponse.`)
    expect(error).toHaveProperty('details', {
      method: 'POST', path, status: 202, expectedStatus: 202, contract: 'SendOperatorMessageResponse',
      contentType: 'application/json', responseBodyPreview: JSON.stringify(original), responseBodyTruncated: false,
    })
    expect(error.cause).toMatchObject({ name: 'ZodError', message: expect.stringContaining('"conversation"') })
    expect(response.body).toStrictEqual(original)
  })

  it('returns the entire accepted state without changing the response or input state', () => {
    const { before, input, body } = acceptanceFixture()
    const response = publicResponse(body)
    const original = structuredClone({ before, input, body })
    const accepted = assertAcceptedOperatorTurn(response, before, input, [])
    expect(accepted).toStrictEqual(original.body)
    expect({ before, input, body: response.body }).toStrictEqual(original)
  })

  it('still rejects changed message content in an otherwise accepted response', () => {
    const { before, input, body } = acceptanceFixture()
    body.state.messages[0]!.content = 'Different admitted text.'
    assert.throws(() => assertAcceptedOperatorTurn(publicResponse(body), before, input, []))
  })

  it('still rejects an unexpected field in the complete accepted state', () => {
    const { before, input, body } = acceptanceFixture()
    const extra = { ...body, state: { ...body.state, unexpected: true } }
    assert.throws(() => assertAcceptedOperatorTurn(publicResponse(extra), before, input, []))
  })

  it('still requires the conversation update timestamp to be present', () => {
    const { before, input, body } = acceptanceFixture()
    const conversation: Record<string, unknown> = { ...body.state.conversation }
    delete conversation.updatedAt
    const missingTimestamp = { ...body, state: { ...body.state, conversation } }
    assert.throws(() => assertAcceptedOperatorTurn(publicResponse(missingTimestamp), before, input, []))
  })

  it('still requires the accepted message creation and update timestamps to agree', () => {
    const { before, input, body } = acceptanceFixture()
    body.state.messages[0]!.updatedAt = '2026-10-18T12:00:02.000Z'
    assert.throws(() => assertAcceptedOperatorTurn(publicResponse(body), before, input, []))
  })

  it('still rejects a conversation update timestamp earlier than its prior state', () => {
    const { before, input, body } = acceptanceFixture()
    body.state.conversation.updatedAt = '2026-10-18T11:59:59.000Z'
    assert.throws(() => assertAcceptedOperatorTurn(publicResponse(body), before, input, []))
  })
})
