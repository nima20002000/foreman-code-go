import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { APP_MCP_SERVER_NAME, appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { OpenCodeNativeDeliveryError, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import type { WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { FixtureServer, json, request } from './opencode-fixtures.js'

// Native qualification and command output below are test doubles, NOT provider qualification evidence.
vi.mock('../src/modules/harnesses/codexProtocol.js', () => ({
  canonical: JSON.stringify,
  qualifyCodex: vi.fn(async () => ({ binary: 'not-executed', providerVersion: 'codex-cli 0.154.0', protocol: {} })),
  assertCodexUnchanged: vi.fn(async () => {}),
}))
vi.mock('../src/modules/harnesses/codexQualification.js', () => ({ qualifyNativeCodexModel: vi.fn(async () => {}) }))
vi.mock('../src/modules/harnesses/process.js', () => ({ runCommand: vi.fn() }))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
beforeEach(() => { vi.mocked(runCommand).mockReset() })
function codexInput(): WorkflowNativeSessionStart {
  const f = makeCurrentWorkflowFixture('f3-native', 'single')
  return { kind: 'workflow', correlationId: 'chat-correlation', request: { executionId: 'agent-chat:conversation', runId: 'agent-chat:conversation',
    workspaceId: f.scope.workspaceId, workflowNodeId: f.version.definition.nodes[0]!.id, workingDirectory: '/fixture-read-only',
    runtimeDirectory: '/fixture-runtime', configuration: f.configurations[0]!, input: {} } }
}
function scopedCodexEntry(enabled = true) {
  const entry = appLauncherConnection()
  return { name: APP_MCP_SERVER_NAME, enabled, transport: { type: 'stdio', command: entry.executable, args: entry.arguments, env_vars: entry.environmentVariables } }
}
function scopedCodexCommand(args: readonly string[], entry = scopedCodexEntry()) {
  if (args[1] === 'get' && args[2] !== APP_MCP_SERVER_NAME) return { exitCode: 1, stdout: '',
    stderr: `Error: No MCP server named '${args[2]}' found.` }
  return { exitCode: 0, stdout: JSON.stringify(args[1] === 'list' ? [entry] : entry), stderr: '' }
}
function code(expected: string) {
  return (error: unknown) => error instanceof HarnessExecutionError && error.result.error?.code === expected
}
function codex(chat = true) {
  const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, chat ? 'none' : 'scoped')
  const transport = vi.fn(async () => { throw new Error('A native transport must not open in this test') })
  manager['transport'] = transport
  cleanups.push(() => manager.dispose())
  return { manager, transport }
}
function openCode() {
  const server = new FixtureServer()
  server.config = { mcp: { [APP_MCP_SERVER_NAME]: { type: 'local', enabled: false, command: ['fixture-launcher'] } } }
  const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpAccess: 'none' })
  cleanups.push(() => manager.dispose())
  return { manager, server }
}
const codexSource: NativeSessionReference = { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'origin-thread' }
const openCodeSource: NativeSessionReference = { harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'missing-source' }

describe('F3 safe native boundaries (mock command output and HTTP only)', () => {
  for (const operation of ['create', 'attach', 'fork'] as const) {
    it(`A-R01: Codex ${operation} refuses injected scoped credentials before opening a transport`, async () => {
      vi.mocked(runCommand).mockImplementation(async (_binary, args) => scopedCodexCommand(args))
      const { manager, transport } = codex(), input = codexInput()
      input.environment = { agentId: input.request.configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: 'must-not-be-injected' } }
      const snapshot = structuredClone(input)
      const result = operation === 'create' ? manager.createSession(input)
        : operation === 'attach' ? manager.attachSession(codexSource, input) : manager.forkSession(codexSource, input)
      await assert.rejects(result, code('CODEX_APP_MCP_UNAVAILABLE'))
      assert.equal(transport.mock.calls.length, 0); assert.deepEqual(input, snapshot)
      assert.deepEqual(input.environment, snapshot.environment)
      for (const call of vi.mocked(runCommand).mock.calls) {
        assert.equal(call[1][0], 'mcp')
        assert(!call[4] || !('GRAPHQL_MCP_TOKEN' in call[4]))
      }
    })
    it(`A-R01: OpenCode ${operation} refuses an enabled App entry without session mutation`, async () => {
      const { manager, server } = openCode()
      server.config = { mcp: { [APP_MCP_SERVER_NAME]: { type: 'local', enabled: true, command: ['fixture-launcher'] } } }
      const input: WorkflowNativeSessionStart = { request: request() }
      const result = operation === 'create' ? manager.createSession(input)
        : operation === 'attach' ? manager.attachSession(openCodeSource, input) : manager.forkSession(openCodeSource, input)
      await assert.rejects(result, code('OPENCODE_APP_MCP_UNAVAILABLE'))
      assert.equal(server.calls.filter((call) => call.method !== 'GET').length, 0)
      assert.equal(server.restartEnvironments.length, 0); assert.equal(input.environment, undefined)
    })
  }
  it('A-R01: disabled Codex entry is credential-free while non-chat scoped validation remains mandatory', async () => {
    vi.mocked(runCommand).mockImplementation(async (_binary, args) => scopedCodexCommand(args, scopedCodexEntry(false)))
    const { manager } = codex(), input = codexInput()
    const prepared = await manager['prepareInput'](input)
    assert.equal(prepared.scopedCredentialVariable, undefined); assert.equal(prepared.input.environment, undefined)
    assert.equal(prepared.environment.GRAPHQL_MCP_TOKEN, undefined)
    assert.deepEqual(prepared.harnessConfiguration, input.request.configuration.harness)
    const ordinary = codex(false).manager
    vi.mocked(runCommand).mockImplementation(async (_binary, args) => scopedCodexCommand(args))
    await assert.rejects(ordinary['prepareInput'](input), code('CODEX_SCOPED_ENVIRONMENT_REQUIRED'))
    await assert.rejects(manager['prepareInput']({ ...input, environment: { agentId: input.request.configuration.agentId,
      variables: { GRAPHQL_MCP_TOKEN: 'must-not-be-injected' } } }), code('CODEX_APP_MCP_UNAVAILABLE'))
    await assert.rejects(manager['prepareInput']({ ...input, environment: { agentId: 'different-agent', variables: {} } }), code('CODEX_SESSION_OWNER_MISMATCH'))
  })
  it('A-R01: OpenCode disabled App entry remains disabled and refuses injected credentials', async () => {
    const { manager, server } = openCode()
    server.config = { mcp: { [APP_MCP_SERVER_NAME]: { type: 'local', enabled: false, command: ['fixture-launcher'] } } }
    const input: WorkflowNativeSessionStart = { request: request() }
    const session = await manager.createSession(input)
    assert.equal(session.harness, 'opencode')
    assert.equal(server.calls.filter((call) => /\/mcp\/.+\/connect/.test(call.path)).length, 0)
    await assert.rejects(manager['bindEnvironment']({ agentId: 'agent-1', variables: { GRAPHQL_MCP_TOKEN: 'must-not-be-injected' } }, new AbortController().signal),
      code('OPENCODE_APP_MCP_UNAVAILABLE'))
  })
  for (const operation of ['attach', 'fork'] as const) {
    for (const status of [404, 503]) {
      it(`A-R13: OpenCode ${operation} HTTP ${status} preserves missing-vs-transient evidence`, async () => {
        const { manager, server } = openCode()
        server.beforeRequest = (path) => path.startsWith('/session/missing-source') ? json({ message: 'fixture error' }, status) : undefined
        const input: WorkflowNativeSessionStart = { request: request() }
        const result = operation === 'attach' ? manager.attachSession(openCodeSource, input) : manager.forkSession(openCodeSource, input)
        await assert.rejects(result, (error: unknown) => {
          let cause = error
          if (operation === 'fork') {
            assert(error instanceof NativeDeliveryError)
            assert.equal(error.operation, 'session_creation')
            assert.equal(error.delivery, status === 404 ? 'not_sent' : 'unknown')
            assert.equal(error.cleanup, 'confirmed')
            cause = error.cause
          }
          assert(cause instanceof OpenCodeNativeDeliveryError)
          assert.equal(cause.certainty, status === 404 ? 'definite' : 'uncertain')
          assert.equal(cause.code, status === 404 ? 'OPENCODE_SESSION_NOT_FOUND'
            : operation === 'attach' ? 'OPENCODE_SERVER_REQUEST_FAILED' : 'OPENCODE_NATIVE_DELIVERY_REJECTED')
          return true
        })
        assert.equal(server.calls.filter((call) => call.method === 'POST' && new URL(call.path, 'http://fixture.invalid').pathname === '/session').length, 0)
        assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 0)
      })
    }
  }
})
