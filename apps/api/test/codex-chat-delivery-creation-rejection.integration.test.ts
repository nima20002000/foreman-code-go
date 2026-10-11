import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { until } from './fixtures/codex-test-helpers.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'

describe.skipIf(!postgresEnabled)('Codex chat delivery through authenticated MCP', { timeout: 60_000 }, () => {
  const fixture = useCodexChatDelivery()

  for (const kind of ['agent', 'operator'] as const) {
    it(`${kind} retains a late definitive creation rejection, cleans up, and permits explicit retry`, async () => {
      const {
        native, repository, request, sendAgent, readAgent, createOperator, sendOperator, readOperator,
      } = fixture
      await native.flag('late-reject-thread-start')
      const id = kind === 'agent' ? (await sendAgent(request('late-rejected', null))).state.conversation!.id
        : await createOperator()
      if (kind === 'operator') await sendOperator(id, 'late-rejected')
      await until(async () => kind === 'agent'
        ? (await repository.turn(id, 'late-rejected'))?.delivery === 'unknown' || undefined
        : (await readOperator(id)).turnState === 'uncertain' || undefined)
      await until(async () => {
        if (kind === 'agent') {
          await fixture.agentChat.recover()
          return (await repository.turn(id, 'late-rejected'))?.delivery === 'failed' || undefined
        }
        await fixture.operatorChat.reconcileActive()
        return (await readOperator(id)).turnState === 'error' || undefined
      })
      assert.equal((await native.wire('thread/start')).length, 1)
      assert.equal((await native.wire('turn/start')).length, 0)
      if (kind === 'agent') {
        assert.equal((await repository.get(id))!.record.sessionCreation, undefined)
        assert.equal((await readAgent()).availability.canSend, true)
      } else assert.equal((await readOperator(id)).activeRequestId, null)
      await native.unflag('late-reject-thread-start')
      if (kind === 'agent') {
        await sendAgent(request('retry', id))
        await until(async () => (await repository.turn(id, 'retry'))?.delivery === 'completed' || undefined)
      } else {
        await sendOperator(id, 'retry')
        await until(async () => (await readOperator(id)).turnState === 'idle' || undefined)
      }
      assert.equal((await native.wire('thread/start')).length, 2)
      assert.equal((await native.wire('turn/start')).length, 1)
    })

  }
})
