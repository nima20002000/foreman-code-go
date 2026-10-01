import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { CodexAppServerSessionManager, type CodexSessionDependencies, type CodexTransport } from '../src/modules/harnesses/codexAppServer.js'
import { QUALIFIED_CODEX_VERSION } from '../src/modules/harnesses/codexProtocol.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'

function replay() {
  const calls: string[] = []
  let cleanupFailures = 0
  const dependencies: CodexSessionDependencies = {
    mode: 'replay',
    environment: () => ({}),
    qualify: async (binary) => {
      calls.push('qualify')
      return { binary, identity: 'recorded-launcher', protocol: fixtureProtocol, providerVersion: QUALIFIED_CODEX_VERSION,
        schemaManifestSha256: 'recorded-schema', stableSchemaGitBlob: 'recorded-stable', referenceSchemaManifestSha256: 'recorded-reference' }
    },
    assertUnchanged: async () => { calls.push('assertUnchanged') },
    runCommand: async (_binary, args) => {
      calls.push(args.join(' '))
      return { stdout: args[1] === 'list' ? '[]' : '', stderr: '', exitCode: args[1] === 'get' ? 1 : 0, exitSignal: null }
    },
    qualifyModel: async () => { calls.push('qualifyModel') },
    id: () => 'recorded-connection', now: () => new Date('2026-10-01T00:00:00Z'),
    schedule: setTimeout, cancelTimer: clearTimeout,
    transport: (binary, cwd) => {
      calls.push(`transport:${binary}:${cwd}`)
      const transport: CodexTransport = {
        start: async () => { calls.push('start') },
        close: async () => { calls.push('close'); if (cleanupFailures-- > 0) throw new Error('cleanup failed') },
        respond: async () => { throw new Error('Unexpected response') }, reject: async () => { throw new Error('Unexpected rejection') },
        request: async (method, params) => {
          calls.push(method)
          if (method !== 'thread/start') throw new Error(`Unexpected method ${method}`)
          const config = params?.config as JsonObject
          return { thread: { id: 'recorded-native-thread', turns: [], ephemeral: params?.ephemeral },
            model: params?.model, modelProvider: 'openai', cwd: params?.cwd, reasoningEffort: config.model_reasoning_effort,
            serviceTier: null, approvalPolicy: params?.approvalPolicy, approvalsReviewer: params?.approvalsReviewer,
            sandbox: { type: 'readOnly', networkAccess: false } }
        },
      }
      return transport
    },
  }
  return { dependencies, calls, failCleanup: () => { cleanupFailures = 1 } }
}

describe('Codex production/replay dependency boundary', () => {
  it('refuses incomplete replay before starting any native work', () => {
    assert.throws(() => new CodexAppServerSessionManager('/missing', undefined, undefined, undefined, undefined, undefined,
      { mode: 'replay' } as CodexSessionDependencies), /every native IO boundary/)
  })

  it('uses the complete injected boundary, deduplicates native creation and retries failed cleanup', async () => {
    const fixture = replay()
    const manager = new CodexAppServerSessionManager('/nonexistent-recorded-codex', undefined, undefined, undefined, undefined, undefined, fixture.dependencies)
    const source = input('/nonexistent-recorded-workspace')
    delete source.environment
    const first = await manager.createSession(source)
    assert.equal(first.nativeSessionId, 'recorded-native-thread')
    assert.deepEqual(await manager.createSession(source), first)
    assert.equal(fixture.calls.filter((value) => value === 'thread/start').length, 1)
    assert(fixture.calls.includes('assertUnchanged'))
    assert(fixture.calls.includes('qualifyModel'))
    const history = await manager.history(first)
    assert.equal(history.events[0]?.connectionId, 'recorded-connection')
    assert.equal(history.events[0]?.occurredAt, '2026-10-01T00:00:00.000Z')
    fixture.failCleanup()
    await assert.rejects(manager.shutdown(), /cleanup failed/)
    await manager.shutdown()
    assert(fixture.calls.filter((value) => value === 'close').length >= 2)
  })
})
