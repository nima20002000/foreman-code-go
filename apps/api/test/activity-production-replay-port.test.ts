import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { input } from './fixtures/codex-test-helpers.js'
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

for (const uncertain of [false, true]) it(`the real adapter keeps recorded ${uncertain ? 'uncertain' : 'acknowledged'} approval delivery distinct`, async () => {
  const replay = new ActivityProductionReplay(), infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected recorded replay infrastructure.')
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined, undefined, 'none', undefined, infrastructure.codex)
  const source = input('/recorded-workspace'); delete source.environment
  try {
    const session = await manager.createSession(source)
    const iterator = manager.startTurn(session, { prompt: 'Recorded approval', clientCorrelationId: 'recorded-request' })[Symbol.asyncIterator]()
    await iterator.next()
    const original = replay.starts[0]!
    await replay.ask(session.nativeSessionId, original.nativeTurnId, 'original-request')
    const pending = (await manager.pending(session))!
    expect(pending.turn.nativeRequestId).toBeDefined()
    const option = pending.responseOptions.find(entry => entry.semantic === 'approve_once')!
    if (uncertain) replay.nextResponse = 'uncertain'
    const response = manager.respond(session, pending.turn.nativeRequestId!, option, AbortSignal.timeout(1000))
    if (uncertain) {
      await expect(response).rejects.toThrow('outcome of native/respond is uncertain')
      expect((await manager.history(session)).pendingInteractions).toHaveLength(1)
      await expect(manager.respond(session, pending.turn.nativeRequestId!, option)).rejects.toThrow('cannot be retransmitted')
    } else {
      await expect(response).resolves.toBeUndefined()
      expect((await manager.history(session)).pendingInteractions).toHaveLength(0)
    }
    expect(replay.responses).toEqual([{ sessionId: session.nativeSessionId, rpcId: 'original-request' }])
    expect(replay.starts).toHaveLength(1)
  } finally { await manager.dispose() }
})
