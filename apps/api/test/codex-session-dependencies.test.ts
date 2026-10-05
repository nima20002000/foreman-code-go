import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { CodexAppServerSessionManager, type CodexSessionDependencies, type CodexTransport } from '../src/modules/harnesses/codexAppServer.js'
import { QUALIFIED_CODEX_VERSION } from '../src/modules/harnesses/codexProtocol.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'

function replay() {
  const calls: string[] = []
  let cleanupFailures = 0
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
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
    withDiagnostics: async (_pin, run) => run(dependencies),
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

describe('Codex original placed inspection directory',()=>{
  it.each([undefined,'/actual-admitted-source/src'])('qualifies and inspects MCP in the same actual directory with option %s',async workingDirectory=>{
    const f=replay(),qualified:string[]=[],commands:string[]=[]
    const qualify=f.dependencies.qualify
    f.dependencies.qualify=async(...args)=>{qualified.push(args[2]);return qualify(...args)}
    f.dependencies.runCommand=async(...args)=>{
      commands.push(args[2])
      if (args[1][1] === 'list') {
        assert.deepEqual(args[1], ['mcp', 'list', '--json'])
        return { stdout: JSON.stringify([{ name: 'graphql' }]), stderr: '', exitCode: 0 }
      }
      assert.deepEqual(args[1], ['mcp', 'get', 'graphql', '--json'])
      return { stdout: JSON.stringify({ enabled: false, transport: { type: 'stdio' } }), stderr: '', exitCode: 0 }
    }
    const manager=new CodexAppServerSessionManager('/nonexistent-recorded-codex',undefined,undefined,undefined,undefined,undefined,f.dependencies,
      workingDirectory?{workingDirectory}:{})
    await manager.capabilities()
    const inspected = await manager.inspectMcp()
    assert.equal(inspected.serverName, 'graphql')
    assert.equal(inspected.state, 'disabled')
    await manager.qualificationEvidence()
    assert.deepEqual(qualified,[workingDirectory??process.cwd(),workingDirectory??process.cwd(),workingDirectory??process.cwd()])
    assert.deepEqual(commands,[workingDirectory??process.cwd(),workingDirectory??process.cwd()])
    assert(!f.calls.includes('start'))
    assert(!f.calls.includes('qualifyModel'))
    await manager.shutdown()
  })
})
