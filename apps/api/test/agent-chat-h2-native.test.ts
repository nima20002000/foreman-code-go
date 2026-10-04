import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { assertOpenCodeChatMcpDisabled, buildOpenCodeChatConfigContent } from '../src/modules/harnesses/opencodeTransport.js'
import { nativePolicy } from '../src/modules/harnesses/opencodeProtocol.js'
import type { WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { runCommand, signalTree, spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'
import { spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'

// In-memory native wire fixtures. No executable, provider, database, or network is used.
// The actual managers AND transports run; only process I/O and qualification are substituted.
vi.mock('../src/modules/harnesses/process.js', () => ({ PROCESS_SHUTDOWN_GRACE_MS: 1, runCommand: vi.fn(), signalTree: vi.fn(), spawnOwnedStdioProcess: vi.fn() }))
vi.mock('../src/modules/harnesses/recovery/processRegistry.js', () => ({ spawnNativeProcess: vi.fn() }))
vi.mock('../src/modules/harnesses/codexQualification.js', () => ({ qualifyNativeCodexModel: vi.fn(async () => {}) }))
vi.mock('../src/modules/harnesses/codexProtocol.js', () => ({
  QUALIFIED_CODEX_VERSION: 'codex-cli 0.154.0', QUALIFIED_CODEX_SCHEMA_SHA256: 'fixture-only',
  isQualifiedCodexVersion: (value: string) => value === 'codex-cli 0.154.0', canonical: JSON.stringify,
  qualifyCodex: vi.fn(async () => ({ binary: 'not-executed', providerVersion: 'codex-cli 0.154.0', protocol: {
    request() {}, notification() {}, response() {}, serverRequest() {}, serverResponse() {},
  } })), assertCodexUnchanged: vi.fn(async () => {}),
}))

type Obj = Record<string, unknown>
const cleanups: Array<() => Promise<void>> = []
const calls: Array<{ method: string; params: Obj }> = []
let ignoreOverride = false
let configured = true
let codexServers: string[] = ['graphql']
const inherited = { model: 'unrelated/model', plugin: ['keep-this-plugin'], mcp: {
  graphql: { type: 'local', command: ['fixture-app-launcher'], enabled: true },
  docs: { type: 'remote', url: 'https://docs.invalid/mcp', enabled: true, headers: { 'X-Example': 'keep' } },
  disabled: { type: 'local', command: ['fixture-other'], enabled: false },
} }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const object = (value: unknown) => value as Obj
function errorCode(expected: string) {
  return (error: unknown) => error instanceof HarnessExecutionError && error.result.error?.code === expected
}
function input(harness: 'codex' | 'opencode'): WorkflowNativeSessionStart {
  const fixture = makeCurrentWorkflowFixture('h2-native', 'single')
  const configuration = structuredClone(fixture.configurations[0]!)
  if (harness === 'codex') {
    assert.equal(configuration.harness.harness, 'codex')
    if (configuration.harness.harness !== 'codex') throw new Error('The fixture must select Codex.')
    configuration.harness.sandbox = 'read-only'
    configuration.harness.advanced = structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION)
    if (configured) configuration.harness.advanced.mcpServers = {
      graphql: { enabled: true, required: true, disabledTools: [], tools: {} },
      docs: { enabled: true, required: false, disabledTools: [], tools: {} },
    }
  } else {
    const advanced = structuredClone(DEFAULT_OPENCODE_ADVANCED_CONFIGURATION)
    advanced.mcp.serverEnabled = { graphql: true, docs: true, disabled: false }
    configuration.harness = { harness, model: 'opencode-go/deepseek-v4.1-flash', variant: 'max', nativeAgent: 'build',
      thinking: false, autoApprove: false, advanced }
  }
  return { kind: 'workflow', correlationId: 'h2-chat', request: {
    executionId: 'agent-chat:h2', runId: 'agent-chat:h2', workspaceId: configuration.workspaceId,
    workflowNodeId: fixture.version.definition.nodes[0]!.id, workingDirectory: '/h2-fixture', runtimeDirectory: '/h2-fixture', configuration, input: {},
  } }
}
function childProcess(onWrite?: (text: string) => void) {
  return Object.assign(new EventEmitter(), { pid: 123456789, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) { onWrite?.(String(chunk)); done() } }),
  }) as EventEmitter & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null;
    stdout: PassThrough; stderr: PassThrough; stdin: Writable }
}
function closeChild(child: ReturnType<typeof childProcess>) {
  child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0)
}
function installCodexWire() {
  vi.mocked(spawnOwnedStdioProcess).mockImplementation((options) => {
    const servers: Obj = { docs: { enabled: true }, disabled: { enabled: false } }
    for (const name of codexServers) servers[name] = { enabled: ignoreOverride || !options.args.includes(`mcp_servers.${name}.enabled=false`) }
    let resolveClosed!: (exit: Awaited<ReturnType<typeof spawnOwnedStdioProcess>['closed']>) => void
    const closed = new Promise<Awaited<ReturnType<typeof spawnOwnedStdioProcess>['closed']>>((resolve) => { resolveClosed = resolve })
    const child = childProcess((text) => {
      const request = object(JSON.parse(text)), method = String(request.method), params = object(request.params ?? {})
      calls.push({ method, params })
      if (request.id === undefined) { assert.equal(method, 'initialized'); return }
      let result: unknown
      if (method === 'initialize') result = {}
      else if (method === 'config/read') result = { config: { mcp_servers: servers } }
      else if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) result = {
        thread: { id: method === 'thread/resume' ? params.threadId : 'chat-child', turns: [] },
        model: params.model, reasoningEffort: object(params.config).model_reasoning_effort,
        cwd: params.cwd, serviceTier: params.serviceTier, approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'readOnly' },
      }
      else if (method === 'thread/read') result = { thread: { id: params.threadId, turns: [] } }
      else if (method === 'thread/turns/list') result = { data: [], nextCursor: null }
      else throw new Error(`Unexpected Codex method ${method}`)
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'))
    })
    return { child: child as unknown as ChildProcessWithoutNullStreams, closed,
      close: async () => { closeChild(child); resolveClosed({ exitCode: 0, exitSignal: null }) } }
  })
}
function installOpenCodeWire(start: WorkflowNativeSessionStart) {
  const harness = start.request.configuration.harness
  assert.equal(harness.harness, 'opencode')
  if (harness.harness !== 'opencode') throw new Error('OpenCode fixture expected.')
  const source = { id: 'run-source', directory: '/h2-fixture', permission: nativePolicy(harness) }
  const sessions = new Map<string, Obj>([['run-source', structuredClone(source)]])
  let effective: Obj = {}, status: Obj = {}
  vi.mocked(spawnNativeProcess).mockImplementation((_binary, _args, options) => {
    assert.ok(options)
    const overlay = JSON.parse(String(options.env?.OPENCODE_CONFIG_CONTENT ?? '{}')) as Obj
    const original = structuredClone(inherited)
    effective = { ...original, ...overlay, mcp: { ...original.mcp, ...object(overlay.mcp) } }
    if (ignoreOverride) object(effective.mcp).graphql = original.mcp.graphql
    status = Object.fromEntries(Object.entries(object(effective.mcp)).map(([name, entry]) =>
      [name, { status: object(entry).enabled === false ? 'disabled' : 'connected' }]))
    // Exercise accepted controls for unrelated MCP entries instead of silently ignoring them.
    status.docs = { status: 'disabled' }; status.disabled = { status: 'connected' }
    const child = childProcess()
    queueMicrotask(() => child.stdout.write('opencode server listening on http://127.0.0.1:43210\n'))
    return child as unknown as ChildProcessWithoutNullStreams
  })
  vi.mocked(signalTree).mockImplementation(async (child) => { closeChild(child as unknown as ReturnType<typeof childProcess>) })
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname, method = init?.method ?? 'GET'
    const body = init?.body ? object(JSON.parse(String(init.body))) : {}
    calls.push({ method: `${method} ${route}`, params: body })
    if (route === '/global/health') return json({ healthy: true, version: '1.18.31' })
    if (route === '/doc') return json({ paths: Object.fromEntries([
      '/session', '/session/status', '/session/{sessionID}', '/session/{sessionID}/message', '/session/{sessionID}/message/{messageID}',
      '/session/{sessionID}/prompt_async', '/session/{sessionID}/abort', '/permission', '/permission/{requestID}/reply',
      '/question', '/question/{requestID}/reject', '/event', '/config', '/mcp',
    ].map((path) => [path, {}])) })
    if (route === '/config') return json(effective)
    if (route === '/mcp') return json(status)
    if (route === '/provider') return json({ all: [{ id: 'opencode-go', models: { 'deepseek-v4.1-flash': { variants: { max: {} } } } }] })
    if (route === '/agent') return json([{ name: 'build' }])
    if (route === '/session/status') return json({})
    if (route === '/session/run-source/fork') { sessions.set('chat-child', { ...structuredClone(source), id: 'chat-child' }); return json({ id: 'chat-child' }) }
    if (route === '/session' && method === 'POST') { sessions.set('chat-child', { ...body, id: 'chat-child', directory: '/h2-fixture' }); return json(sessions.get('chat-child')) }
    if (route.startsWith('/session/')) {
      const session = sessions.get(route.split('/')[2]!)
      assert.ok(session, `Unknown session ${route}`)
      if (method === 'PATCH') Object.assign(session, body)
      else assert.equal(method, 'GET')
      return json(session)
    }
    if (route.startsWith('/mcp/')) {
      const [, , name, action] = route.split('/')
      assert.notEqual(name, 'graphql', 'Chat must never connect, disconnect, or rewrite App MCP after launch.')
      assert.equal(method, 'POST')
      status[name!] = { status: action === 'connect' ? 'connected' : 'disabled' }
      return json(true)
    }
    throw new Error(`Unexpected OpenCode route ${method} ${route}`)
  }))
  return { source, sessions, effective: () => effective, status: () => status }
}
beforeEach(() => {
  vi.resetAllMocks(); calls.length = 0; ignoreOverride = false; configured = true; codexServers = ['graphql']
  vi.stubEnv('GRAPHQL_MCP_TOKEN', 'must-never-reach-chat')
  vi.stubEnv('DATABASE_URL', 'must-never-reach-chat')
  vi.stubEnv('OPENCODE_CONFIG_CONTENT', JSON.stringify(inherited))
  vi.mocked(runCommand).mockImplementation(async (_binary, args) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: '1.18.31', stderr: '' }
    if (args[0] === 'mcp' && args[1] === 'list') return { exitCode: 0, stdout: JSON.stringify(codexServers.map((name) => ({ name }))), stderr: '' }
    assert.deepEqual(args.slice(0, 2), ['mcp', 'get'])
    if (!codexServers.includes(args[2]!) && args[2] !== 'docs') return { exitCode: 1, stdout: '', stderr: '' }
    const launcher = appLauncherConnection()
    return { exitCode: 0, stdout: JSON.stringify({ name: args[2], enabled: true, required: args[2] === 'graphql',
      transport: { type: 'stdio', command: launcher.executable, args: launcher.arguments, env_vars: launcher.environmentVariables } }), stderr: '' }
  })
})
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})

describe('H2 A-R01: chat-only App MCP exclusion, real adapters with in-memory native I/O', () => {
  for (const operation of ['create', 'attach', 'fork'] as const) {
    for (const harness of ['codex', 'opencode'] as const) {
      it(`${harness} ${operation}: enabled accepted App entry works without credentials and preserves other settings`, async () => {
        const start = input(harness), before = structuredClone(start)
        const source: NativeSessionReference = { harness, nativeSessionId: 'run-source', providerVersion: harness === 'codex' ? 'codex-cli 0.154.0' : '1.18.31' }
        let manager: CodexAppServerSessionManager | OpenCodeNativeSessionManager
        let wire: ReturnType<typeof installOpenCodeWire> | undefined
        if (harness === 'codex') {
          installCodexWire()
          manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
        } else {
          wire = installOpenCodeWire(start)
          const config = start.request.configuration.harness
          assert.equal(config.harness, 'opencode')
          if (config.harness !== 'opencode') throw new Error('Invalid fixture.')
          assert.ok(config.advanced)
          manager = new OpenCodeNativeSessionManager({ appMcpAccess: 'none', ownerAgentId: start.request.configuration.agentId,
            server: new ManagedOpenCodeServer({ binary: 'not-executed', workingDirectory: '/h2-fixture', ownerAgentId: start.request.configuration.agentId,
              advancedConfiguration: config.advanced, appMcpAccess: 'none' }),
          })
        }
        cleanups.push(() => manager.dispose())
        const session = operation === 'create' ? await manager.createSession(start)
          : operation === 'attach' ? await manager.attachSession(source, { ...start, instructionsDelivered: true }) : await manager.forkSession(source, start)
        assert.equal(session.nativeSessionId, operation === 'attach' ? 'run-source' : 'chat-child')
        assert.deepEqual(start, before); assert.equal(start.environment, undefined)
        if (harness === 'codex') {
          const launched = vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0]
          assert.deepEqual(launched.args, ['app-server', '--stdio', '-c', 'mcp_servers.graphql.enabled=false'])
          assert.equal(launched.environment?.GRAPHQL_MCP_TOKEN, undefined); assert.equal(launched.environment?.DATABASE_URL, undefined)
          const method = operation === 'create' ? 'thread/start' : operation === 'attach' ? 'thread/resume' : 'thread/fork'
          const request = calls.find((call) => call.method === method)!
          assert.equal(request.params.model, start.request.configuration.harness.model)
          assert.equal(object(request.params.config)['mcp_servers.graphql.enabled'], false)
          assert.deepEqual(object(request.params.config).shell_environment_policy, {
            inherit: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.inherit,
            ignore_default_excludes: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.ignoreDefaultExcludes,
            filters: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.filters, set: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.set,
          })
          assert.equal(calls.filter((call) => call.method === method).length, 1)
          assert.ok(calls.findIndex((call) => call.method === 'config/read') < calls.indexOf(request))
          if (operation !== 'create') assert.equal(request.params.developerInstructions, undefined)
          assert.ok(!calls.some((call) => ['turn/start', 'turn/interrupt', 'config/value/write'].includes(call.method)))
        } else {
          const env = vi.mocked(spawnNativeProcess).mock.calls[0]![2]!.env!
          assert.equal(env.GRAPHQL_MCP_TOKEN, undefined); assert.equal(env.DATABASE_URL, undefined)
          assert.deepEqual(object(wire!.effective().mcp).docs, inherited.mcp.docs)
          assert.deepEqual(wire!.effective().plugin, inherited.plugin)
          assert.equal(object(object(wire!.effective().mcp).graphql).enabled, false)
          assert.deepEqual(wire!.status(), { graphql: { status: 'disabled' }, docs: { status: 'connected' }, disabled: { status: 'disabled' },
            'graphql-app': { status: 'disabled' }, 'graphql-operator': { status: 'disabled' } })
          if (operation !== 'attach') assert.deepEqual(wire!.sessions.get('run-source'), wire!.source, 'Fork/create must leave the Run source untouched.')
          assert.ok(calls.findIndex((call) => call.method === 'GET /mcp') < calls.findIndex((call) => call.method.includes('/session')))
        }
      })
    }
  }

  for (const operation of ['create', 'attach', 'fork'] as const) {
    for (const harness of ['codex', 'opencode'] as const) {
      it(`${harness} ${operation}: an ignored launch override fails closed before session access`, async () => {
        ignoreOverride = true
        const start = input(harness)
        let manager: CodexAppServerSessionManager | OpenCodeNativeSessionManager
        if (harness === 'codex') { installCodexWire(); manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none') }
        else {
          installOpenCodeWire(start)
          manager = new OpenCodeNativeSessionManager({ appMcpAccess: 'none', ownerAgentId: start.request.configuration.agentId,
            server: new ManagedOpenCodeServer({ binary: 'not-executed', workingDirectory: '/h2-fixture', ownerAgentId: start.request.configuration.agentId, appMcpAccess: 'none' }),
          })
        }
        cleanups.push(() => manager.dispose())
        const source = { harness, nativeSessionId: 'run-source', providerVersion: harness === 'codex' ? 'codex-cli 0.154.0' : '1.18.31' }
        const result = operation === 'create' ? manager.createSession(start)
          : operation === 'attach' ? manager.attachSession(source, start) : manager.forkSession(source, start)
        await assert.rejects(result, errorCode(`${harness.toUpperCase()}_APP_MCP_UNAVAILABLE`))
        assert.ok(!calls.some((call) => call.method.startsWith('thread/') || call.method.startsWith('POST /session')))
        if (harness === 'opencode') assert.ok(vi.mocked(signalTree).mock.calls.length > 0)
      })
    }
  }

  it('Codex: an installation without App MCP still starts without inventing a transport-less server entry', async () => {
    configured = false; codexServers = []; installCodexWire()
    const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
    cleanups.push(() => manager.dispose())
    await manager.createSession(input('codex'))
    assert.deepEqual(vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0].args, ['app-server', '--stdio'])
    assert.ok(calls.some((call) => call.method === 'config/read'))
    assert.equal(object(calls.find((call) => call.method === 'thread/start')!.params.config)['mcp_servers.graphql.enabled'], undefined)
  })

  for (const [layout, names] of ([
    ['legacy only', ['graphql-app', 'graphql-operator']],
    ['unified only', ['graphql']],
    ['neither', []],
    ['both', ['graphql', 'graphql-app', 'graphql-operator']],
  ] satisfies Array<[string, string[]]>)) {
    it(`Codex: ${layout} config disables only present App MCP entries`, async () => {
      codexServers = [...names]; configured = names.includes('graphql'); installCodexWire()
      const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
      cleanups.push(() => manager.dispose())
      await manager.createSession(input('codex'))
      const expected = names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`])
      assert.deepEqual(vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0].args, ['app-server', '--stdio', ...expected])
      const config = object(calls.find((call) => call.method === 'thread/start')!.params.config)
      for (const name of ['graphql', 'graphql-app', 'graphql-operator']) {
        assert.equal(config[`mcp_servers.${name}.enabled`], names.includes(name) ? false : undefined)
      }
    })
  }

  it('Codex: ordinary workflow mode still requires its scoped credential and has no chat override', async () => {
    installCodexWire()
    const start = input('codex'), manager = new CodexAppServerSessionManager('not-executed')
    cleanups.push(() => manager.dispose())
    await assert.rejects(manager.createSession(start), errorCode('CODEX_SCOPED_ENVIRONMENT_REQUIRED'))
    assert.equal(vi.mocked(spawnOwnedStdioProcess).mock.calls.length, 0)
    await manager.createSession({ ...start, environment: { agentId: start.request.configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: 'scoped-workflow-fixture' } } })
    const launch = vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0]
    assert.deepEqual(launch.args, ['app-server', '--stdio']); assert.equal(launch.environment?.GRAPHQL_MCP_TOKEN, 'scoped-workflow-fixture')
    assert.ok(!calls.some((call) => call.method === 'config/read'))
    assert.equal(object(calls.find((call) => call.method === 'thread/start')!.params.config)['mcp_servers.graphql.enabled'], undefined)
  })

  it('OpenCode: ordinary workflow launch retains enabled App MCP and its scoped credential', async () => {
    const start = input('opencode'), wire = installOpenCodeWire(start), ownerAgentId = start.request.configuration.agentId
    const server = new ManagedOpenCodeServer({ binary: 'not-executed', workingDirectory: '/h2-fixture', ownerAgentId,
      environment: { agentId: ownerAgentId, variables: { GRAPHQL_MCP_TOKEN: 'scoped-workflow-fixture' } } })
    cleanups.push(() => server.dispose())
    await server.ensure()
    const env = vi.mocked(spawnNativeProcess).mock.calls[0]![2]!.env!
    assert.equal(env.GRAPHQL_MCP_TOKEN, 'scoped-workflow-fixture')
    assert.deepEqual(object(wire.effective().mcp).graphql, inherited.mcp.graphql)
    assert.ok(!calls.some((call) => call.method === 'GET /config' || call.method === 'GET /mcp'))
  })

  it('OpenCode: chat cannot borrow a scoped server or bind a credential on restart', async () => {
    const ownerAgentId = input('opencode').request.configuration.agentId
    const ordinary = new ManagedOpenCodeServer({ binary: 'not-executed', workingDirectory: '/h2-fixture', ownerAgentId })
    assert.throws(() => new OpenCodeNativeSessionManager({ server: ordinary, ownerAgentId, appMcpAccess: 'none' }), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    const server = new ManagedOpenCodeServer({ binary: 'not-executed', workingDirectory: '/h2-fixture', ownerAgentId, appMcpAccess: 'none' })
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId, appMcpAccess: 'none' })
    cleanups.push(() => manager.dispose())
    const credential = { agentId: ownerAgentId, variables: { GRAPHQL_MCP_TOKEN: 'must-not-bind' } }
    await assert.rejects(server.restart(credential), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    await assert.rejects(manager.restartForCredential(credential), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    assert.equal(vi.mocked(spawnNativeProcess).mock.calls.length, 0)
  })

  it('Codex: reopening a retained session re-verifies the chat launch override', async () => {
    installCodexWire()
    const start = input('codex'), manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
    cleanups.push(() => manager.dispose())
    const session = await manager.createSession(start)
    await manager.closeForRestart(session)
    await manager.attachSession(session, { ...start, instructionsDelivered: true })
    assert.equal(vi.mocked(spawnOwnedStdioProcess).mock.calls.length, 2)
    for (const [options] of vi.mocked(spawnOwnedStdioProcess).mock.calls) {
      assert.deepEqual(options.args, ['app-server', '--stdio', '-c', 'mcp_servers.graphql.enabled=false'])
      assert.equal(options.environment?.GRAPHQL_MCP_TOKEN, undefined)
    }
    assert.equal(calls.filter((call) => call.method === 'config/read').length, 2)
    assert.equal(calls.filter((call) => call.method === 'thread/start').length, 1)
    assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 1)
  })

  it('OpenCode: restart restores only other accepted switches and rechecks launch isolation', async () => {
    const start = input('opencode'), before = structuredClone(start), wire = installOpenCodeWire(start)
    const harness = start.request.configuration.harness, ownerAgentId = start.request.configuration.agentId
    if (harness.harness !== 'opencode') throw new Error('Invalid fixture.')
    assert.ok(harness.advanced)
    const server = new ManagedOpenCodeServer({ binary: 'not-executed', workingDirectory: '/h2-fixture', ownerAgentId,
      advancedConfiguration: harness.advanced, appMcpAccess: 'none' })
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId, appMcpAccess: 'none' })
    cleanups.push(() => manager.dispose())
    await manager.createSession(start)
    const generation = server.generation
    await manager.restartForCredential({ agentId: ownerAgentId, variables: {} })
    assert.equal(server.generation, generation + 1)
    assert.equal(vi.mocked(spawnNativeProcess).mock.calls.length, 2)
    assert.deepEqual(wire.status(), { graphql: { status: 'disabled' }, docs: { status: 'connected' }, disabled: { status: 'disabled' },
      'graphql-app': { status: 'disabled' }, 'graphql-operator': { status: 'disabled' } })
    assert.deepEqual(start, before)
    assert.equal(calls.filter((call) => call.method === 'POST /session').length, 1)
    for (const call of vi.mocked(spawnNativeProcess).mock.calls) {
      const env = call[2]!.env!
      assert.equal(env.GRAPHQL_MCP_TOKEN, undefined)
      assert.equal(JSON.parse(String(env.OPENCODE_CONFIG_CONTENT)).mcp.graphql.enabled, false)
    }
    ignoreOverride = true
    await assert.rejects(manager.restartForCredential({ agentId: ownerAgentId, variables: {} }), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    assert.equal(server.generation, generation + 1, 'A failed isolation check cannot publish a new generation.')
  })

  it('OpenCode: chat overlay is narrow, idempotent, and live status cannot contradict disabled config', () => {
    const before = JSON.stringify(inherited), overlay = buildOpenCodeChatConfigContent(before, 'graphql')
    assert.equal(overlay, buildOpenCodeChatConfigContent(overlay, 'graphql'))
    assert.deepEqual(JSON.parse(overlay), { ...inherited, mcp: { ...inherited.mcp, graphql: { ...inherited.mcp.graphql, enabled: false },
      'graphql-app': { enabled: false }, 'graphql-operator': { enabled: false } } })
    assert.equal(JSON.stringify(inherited), before)
    assert.throws(() => assertOpenCodeChatMcpDisabled({}, {}, 'graphql'), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    assertOpenCodeChatMcpDisabled(JSON.parse(overlay), { graphql: { status: 'disabled' } }, 'graphql')
    for (const status of ['connected', 'failed', 'needs_auth', undefined]) {
      assert.throws(() => assertOpenCodeChatMcpDisabled(JSON.parse(overlay), { graphql: { status } }, 'graphql'), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    }
    for (const malformed of [null, [], 'not-an-object']) {
      assert.throws(() => assertOpenCodeChatMcpDisabled(malformed, {}, 'graphql'), errorCode('OPENCODE_APP_MCP_UNAVAILABLE'))
    }
  })
})
