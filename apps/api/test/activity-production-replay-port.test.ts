import { expect, it } from 'vitest'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'

it('the replay Codex port records the third respond argument as its native result', async () => {
  const replay = new ActivityProductionReplay(), infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected the explicit replay infrastructure')
  const port = infrastructure.codex.transport!('/unused-fixture-binary', '/unused', {}, fixtureProtocol,
    async () => {}, () => {}, () => {})
  const started = await port.request('thread/start', {}) as { thread: { id: string } }
  await replay.ask(started.thread.id, 'turn', 'request')
  const result = { output: 'recorded fixture reply' }
  await port.respond('request', 'item/tool/call', result)
  expect(replay.toolReplies.get('request')).toEqual(result)
  expect(replay.responses).toEqual([{ sessionId: started.thread.id, rpcId: 'request' }])
  await port.close()
})
