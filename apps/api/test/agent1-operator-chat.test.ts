import { describe, expect, it } from 'vitest'
import type { OperatorConfigurationVersion } from '@graphql/contracts'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import type { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { configuration as openCodeConfiguration, FixtureServer, json } from './opencode-fixtures.js'
import { deferred, eventually, memoryConversation, operator } from './fixtures/agent1OperatorChat.js'

function fixture() {
  const configuration: OperatorConfigurationVersion = { id: 'operator-v1', operatorId: 'operator-one', version: 1,
    harness: openCodeConfiguration(), contentHash: 'sha256:test', createdAt: new Date().toISOString() }
  const memory = memoryConversation(configuration)
  const server = new FixtureServer()
  const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: configuration.operatorId })
  const chat = new OperatorChatService(memory.repository, {} as PostgresOperatorRepository, () => manager, '/workspace/project', {
    current: async () => operator(), assertConfiguration() {},
    setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp/operator', checkedAt: new Date().toISOString() }),
    prepare: async () => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {},
  })
  return { ...memory, server, manager, chat, owner: operator() }
}

describe('F1: OpenCode Operator cancellation around submission acknowledgement', () => {
  it('breaks the exact manager lock -> onSubmitted -> chat control -> manager.cancel cycle', async () => {
    const f = fixture()
    const submitted = deferred(), acknowledge = deferred()
    f.server.onPrompt = async () => { submitted.resolve(); await acknowledge.promise }
    const command = { requestId: 'during-submit', content: 'Start one native turn.' }
    try {
      await f.chat.send(f.row.id, command, f.owner)
      await submitted.promise // prompt_async accepted, manager lifecycle lock is still held.
      expect((await f.chat.send(f.row.id, command, f.owner)).replayed).toBe(true)
      await f.chat.cancel(f.row.id, command.requestId, f.owner)
      expect(f.row.active_native_turn_id).toBeNull()
      expect(f.server.calls.filter((call) => call.path.includes('/abort'))).toHaveLength(0)
      acknowledge.resolve() // onSubmitted must persist identity and return before awaiting cancel.
      await eventually(() => f.finishResults.length === 1)
      expect(f.finishResults[0]?.outcome).toBe('canceled')
      expect(f.server.calls.filter((call) => call.path.includes('/prompt_async'))).toHaveLength(1)
      expect(f.server.calls.some((call) => call.path.includes('/abort'))).toBe(true)
      expect(f.server.messages.get('ses_test')?.[0]?.info.id).toBe(nativeMessageId(nativeCorrelation(f.row.id, command.requestId)))
      expect((await f.chat.send(f.row.id, command, f.owner)).replayed).toBe(true)
    } finally { acknowledge.resolve(); f.server.closeStreams(); await f.chat.shutdown() }
  })

  it('cancels a submission when the request arrives immediately before prompt acknowledgement', async () => {
    const f = fixture()
    const command = { requestId: 'before-ack', content: 'Do not replay.' }
    f.server.onPrompt = async () => { await f.chat.cancel(f.row.id, command.requestId, f.owner) }
    try {
      await f.chat.send(f.row.id, command, f.owner)
      await eventually(() => f.finishResults.length === 1)
      expect(f.finishResults[0]?.outcome).toBe('canceled')
      expect(f.server.calls.filter((call) => call.path.includes('/prompt_async'))).toHaveLength(1)
    } finally { f.server.closeStreams(); await f.chat.shutdown() }
  })

  it('also converges after acknowledgement without relying on a new SSE event', async () => {
    const f = fixture()
    const command = { requestId: 'after-ack', content: 'One prompt.' }
    try {
      await f.chat.send(f.row.id, command, f.owner)
      await eventually(() => Boolean(f.row.active_native_turn_id))
      await f.chat.cancel(f.row.id, command.requestId, f.owner)
      expect(f.finishResults[0]?.outcome).toBe('canceled')
      expect(f.server.calls.filter((call) => call.path.includes('/prompt_async'))).toHaveLength(1)
    } finally { f.server.closeStreams(); await f.chat.shutdown() }
  })

  it('retains the original identity when the provider does not acknowledge cancellation', async () => {
    const f = fixture()
    const command = { requestId: 'uncertain-cancel', content: 'Keep my receipt.' }
    f.server.onPrompt = async () => { await f.chat.cancel(f.row.id, command.requestId, f.owner) }
    f.server.beforeRequest = (path) => path.includes('/abort') ? json(false) : undefined
    try {
      await f.chat.send(f.row.id, command, f.owner)
      await eventually(() => f.row.turn_state === 'uncertain')
      expect(f.row.active_request_id).toBe(command.requestId)
      expect(f.row.active_native_turn_id).toBe(nativeMessageId(nativeCorrelation(f.row.id, command.requestId)))
      expect(f.finishResults).toHaveLength(0)
      expect(f.server.calls.filter((call) => call.path.includes('/prompt_async'))).toHaveLength(1)
    } finally { f.server.closeStreams(); await f.chat.shutdown() }
  })
})
