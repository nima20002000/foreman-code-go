import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type HarnessExecutionRequest } from '@graphql/contracts'

import {
  OpenCodeNativeDeliveryError,
  OpenCodeNativeSessionManager,
  ManagedOpenCodeServer,
  buildOpenCodeConfigContent,
  type OpenCodeServerController,
} from '../src/modules/harnesses/opencodeServer.js'
import type { NativeMcpEntryEvidence } from '../src/modules/harnesses/mcpDetection.js'

const requiredPaths = {
  '/session': {}, '/session/{sessionID}/prompt_async': {}, '/session/{sessionID}/abort': {},
  '/permission': {}, '/permission/{requestID}/reply': {}, '/event': {}, '/config': {}, '/mcp': {},
}

function request(): HarnessExecutionRequest {
  return {
    executionId: 'execution-1', runId: 'run-1', workspaceId: 'workspace-1', workflowNodeId: 'node-1',
    workingDirectory: '/workspace/project', runtimeDirectory: '/workspace/project', input: {},
    configuration: {
      id: 'config-opencode', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
      prompt: { system: 'Test' }, assignedSkills: [],
      harness: {
        harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max',
        nativeAgent: 'build', thinking: false, autoApprove: false,
      },
      contentHash: 'sha256:test', createdAt: '2026-09-16T00:00:00.000Z',
    },
  }
}

class FakeServer implements OpenCodeServerController {
  readonly expectedVersion = '1.18.31'
  readonly calls: { path: string; init?: RequestInit }[] = []
  events: string[] = []
  permissions: unknown[] = []
  messages: unknown[] = []
  failNextMutation = false
  config: Record<string, unknown> = {}
  mcp: Record<string, unknown> = {}
  messagesAfterEventStreams = 0
  eventStreams = 0
  sessionExists = true
  restartEnvironments: unknown[] = []
  sessionIds: string[] = []
  disposals = 0
  mcpEvidence: NativeMcpEntryEvidence | undefined

  async inspectMcpConfiguration() { return this.mcpEvidence }

  async ensure() {}
  async dispose() { this.disposals += 1 }
  async restart(environment: unknown) { this.restartEnvironments.push(environment) }
  async request(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, ...(init ? { init } : {}) })
    const route = path.split('?')[0]
    const method = init?.method ?? 'GET'
    if (this.failNextMutation && method === 'POST' && route !== '/session') {
      this.failNextMutation = false
      throw new Error('socket closed')
    }
    if (route === '/global/health') return json({ healthy: true, version: '1.18.31' })
    if (route === '/doc') return json({ paths: requiredPaths })
    if (route === '/provider') return json({ all: [{ id: 'opencode-go', models: { 'deepseek-v4.1-flash': { variants: { max: {} } } } }] })
    if (route === '/agent') return json([{ name: 'build' }, { name: 'plan' }])
    if (route === '/session' && method === 'POST') return json({ id: this.sessionIds.shift() ?? 'ses_test' })
    if (route === '/session/ses_test' && method === 'GET') return this.sessionExists
      ? json({ id: 'ses_test', directory: '/workspace/project', agent: 'build', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'max' } })
      : new Response('missing', { status: 404 })
    if (route === '/event') { this.eventStreams += 1; return sse(this.events.shift() ?? '') }
    if (route === '/permission') return json(this.permissions)
    if (route === '/session/ses_test/message') return json(this.eventStreams >= this.messagesAfterEventStreams ? this.messages : [])
    if (route === '/permission/per_one/reply' || route === '/permission/per_two/reply') {
      const reply = JSON.parse(String(init?.body)).reply
      const requestID = route.split('/')[2]
      const selected = this.permissions.find((item) => (item as { id?: string }).id === requestID) as { sessionID?: string } | undefined
      this.permissions = reply === 'reject'
        ? this.permissions.filter((item) => (item as { sessionID?: string }).sessionID !== selected?.sessionID)
        : this.permissions.filter((item) => (item as { id?: string }).id !== requestID)
      return json(true)
    }
    if (route === '/session/ses_test/prompt_async') return new Response(null, { status: 204 })
    if (route === '/session/ses_test/abort') return json(true)
    if (route === '/config') return json(this.config)
    if (route === '/mcp') return json(this.mcp)
    if (route === '/mcp/graphql-app/connect' || route === '/mcp/disabled-app/disconnect') return json(true)
    return new Response('not found', { status: 404 })
  }
}

function manager(server: FakeServer) {
  return new OpenCodeNativeSessionManager({
    server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql-app',
    expectedAppMcpEndpoint: 'http://127.0.0.1:4100/mcp/app',
  })
}

async function sessionFor(native: OpenCodeNativeSessionManager, executionRequest = request()) {
  return native.createSession({ request: executionRequest, environment: { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'opaque' } } })
}

describe('OpenCode native server manager', () => {
  it('qualifies the exact live schema and derives a full turn from authoritative history', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    const messageID = 'msg_974cad2dd603827b06e9e6af'
    server.messages = [{
      info: { id: 'msg_assistant', sessionID: 'ses_test', role: 'assistant', parentID: messageID, time: { created: 1, completed: 2 } },
      parts: [{ id: 'prt_1', sessionID: 'ses_test', messageID: 'msg_assistant', type: 'text', text: 'done' }],
    }]
    server.events.push([
      `data: ${JSON.stringify({ id: 'evt_1', type: 'message.part.updated', properties: { sessionID: 'ses_test', part: { type: 'text' } } })}`,
      '',
      `data: ${JSON.stringify({ id: 'evt_2', type: 'session.idle', properties: { sessionID: 'ses_test' } })}`,
      '', '',
    ].join('\n'))

    const events = []
    for await (const event of native.startTurn(session, { prompt: 'hello', clientCorrelationId: 'turn-1' })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['message.part.updated', 'session.idle'])
    expect(await native.reconcile(session, 'turn-1')).toMatchObject({ terminalResult: { outcome: 'succeeded', output: { text: 'done' } } })
    const prompt = server.calls.find((call) => call.path.startsWith('/session/ses_test/prompt_async'))
    expect(JSON.parse(String(prompt?.init?.body))).toMatchObject({ messageID, agent: 'build', variant: 'max', parts: [{ type: 'text', text: 'hello' }] })
    expect(server.calls.findIndex((call) => call.path.startsWith('/event'))).toBeLessThan(server.calls.findIndex((call) => call.path.startsWith('/session/ses_test/prompt_async')))
  })

  it('binds the first scoped environment before native work and rejects credential replacement', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const executionRequest = request()
    const environment = { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'first-token' } }
    await native.createSession({ request: executionRequest, environment })
    expect(server.restartEnvironments).toEqual([environment])
    expect(server.calls[0]?.path).toBe('/global/health')

    await native.createSession({ request: executionRequest, environment: {
      agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'first-token' },
    } })
    expect(server.restartEnvironments).toHaveLength(1)

    await expect(native.createSession({ request: executionRequest, environment: {
      agentId: 'agent-2', variables: { GRAPHQL_APP_MCP_TOKEN: 'other-agent' },
    } })).rejects.toMatchObject({ result: { error: { code: 'OPENCODE_SESSION_OWNER_MISMATCH' } } })
    await expect(native.createSession({ request: executionRequest, environment: {
      agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'replacement' },
    } })).rejects.toMatchObject({ result: { error: { code: 'OPENCODE_CREDENTIAL_CONTEXT_MISMATCH' } } })
    expect(server.restartEnvironments).toHaveLength(1)
  })

  it('fails before native work when the server cannot bind a scoped environment', async () => {
    const server = new FakeServer()
    Object.defineProperty(server, 'restart', { value: undefined })
    await expect(manager(server).createSession({
      request: request(), environment: { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'token' } },
    })).rejects.toMatchObject({ result: { error: { code: 'OPENCODE_SERVER_RESTART_UNSUPPORTED' } } })
    expect(server.calls).toEqual([])
  })

  it('keeps a multi-session server until the last close and then clears its credential binding', async () => {
    const server = new FakeServer()
    server.sessionIds.push('ses_one', 'ses_two', 'ses_three')
    const native = manager(server)
    const environment = { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'token' } }
    const first = await native.createSession({ request: request(), environment })
    const second = await native.createSession({ request: request(), environment })
    expect(server.restartEnvironments).toHaveLength(1)

    await native.close(first)
    expect(server.disposals).toBe(0)
    await native.close(second)
    expect(server.disposals).toBe(1)

    await native.createSession({ request: request(), environment })
    expect(server.restartEnvironments).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')('delivers the scoped App token to the restarted resident child process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-opencode-server-env-'))
    const binary = join(directory, 'opencode-fixture.cjs')
    const pidFile = join(directory, 'server.pid')
    await writeFile(binary, `#!${process.execPath}
const http = require('node:http')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('1.18.31'); process.exit(0) }
const token = process.env.GRAPHQL_APP_MCP_TOKEN
process.on('SIGTERM', () => process.stderr.write(String(token || '') + '\\n', () => process.exit(0)))
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.url === '/global/health') response.end(JSON.stringify({healthy:true,version:'1.18.31'}))
  else if (request.url === '/doc') response.end(JSON.stringify({paths:${JSON.stringify(requiredPaths)}}))
  else if (request.url.startsWith('/provider')) response.end(JSON.stringify({all:[{id:'opencode-go',models:{'deepseek-v4.1-flash':{variants:{max:{}}}}}]}))
  else if (request.url.startsWith('/agent')) response.end(JSON.stringify([{name:'build'}]))
  else if (request.url.startsWith('/session/ses_missing')) { response.statusCode = 404; response.end('{}') }
  else if (request.url.startsWith('/session') && request.method === 'POST') response.end(JSON.stringify({id:'ses_fixture'}))
  else if (request.url === '/test-env') response.end(JSON.stringify({present:token === 'scoped-token'}))
  else { response.statusCode = 404; response.end('{}') }
})
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  console.log('opencode server listening on http://127.0.0.1:' + server.address().port)
})
`, { mode: 0o755 })
    await chmod(binary, 0o755)
    const server = new ManagedOpenCodeServer({
      binary, workingDirectory: directory, ownerAgentId: 'agent-1', pure: true,
    })
    try {
      const environment = { agentId: 'agent-1', variables: { GRAPHQL_APP_MCP_TOKEN: 'scoped-token' } }
      await server.restart(environment)
      await expect(server.request('/test-env').then((response) => response.json())).resolves.toEqual({ present: true })
      await expect(server.restart({ agentId: 'agent-2', variables: { GRAPHQL_APP_MCP_TOKEN: 'replacement' } }))
        .rejects.toMatchObject({ result: { error: { code: 'OPENCODE_CREDENTIAL_OWNER_MISMATCH' } } })
      await expect(server.request('/test-env').then((response) => response.json())).resolves.toEqual({ present: true })

      const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1' })
      const session = await native.createSession({ request: request(), environment })
      const terminalPid = Number(await readFile(pidFile, 'utf8'))
      await native.close(session)
      await expectProcessExited(terminalPid)
      expect(String(Reflect.get(server, 'stderr'))).toContain('[REDACTED]')
      expect(String(Reflect.get(server, 'stderr'))).not.toContain('scoped-token')

      const failedCreate = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1' })
      const invalid = request()
      if (invalid.configuration.harness.harness !== 'opencode') throw new Error('fixture mismatch')
      invalid.configuration.harness.model = 'opencode-go/missing'
      await expect(failedCreate.createSession({ request: invalid, environment }))
        .rejects.toMatchObject({ result: { error: { code: 'OPENCODE_MODEL_UNAVAILABLE' } } })
      await expectProcessExited(Number(await readFile(pidFile, 'utf8')))

      const failedAttach = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1' })
      await expect(failedAttach.attachSession({
        harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'ses_missing',
      }, { request: request(), environment })).rejects.toMatchObject({
        result: { error: { code: 'OPENCODE_SESSION_NOT_FOUND' } },
      })
      await expectProcessExited(Number(await readFile(pidFile, 'utf8')))
    } finally {
      await server.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reconnects a dropped SSE stream and deduplicates provider events', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.messagesAfterEventStreams = 2
    server.events.push(
      `data: not-json\n\ndata: ${JSON.stringify({ id: 'evt_duplicate', type: 'message.updated', properties: { sessionID: 'ses_test', info: {} } })}\n\n`,
      [
        `data: ${JSON.stringify({ id: 'evt_duplicate', type: 'message.updated', properties: { sessionID: 'ses_test', info: {} } })}`,
        '',
        `data: ${JSON.stringify({ id: 'evt_idle', type: 'session.idle', properties: { sessionID: 'ses_test' } })}`,
        '', '',
      ].join('\n'),
    )
    server.messages = [{
      info: { id: 'msg_assistant', sessionID: 'ses_test', role: 'assistant', parentID: 'msg_91669c43679f43422efee576', time: { created: 1, completed: 2 } },
      parts: [{ type: 'text', text: 'recovered' }],
    }]
    const events = []
    for await (const event of native.startTurn(session, { prompt: 'go', clientCorrelationId: 'reconnect' })) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['message.updated', 'session.idle'])
    expect(server.calls.filter((call) => call.path.startsWith('/event'))).toHaveLength(2)
    expect(server.calls.filter((call) => call.path.startsWith('/session/ses_test/prompt_async'))).toHaveLength(1)
  })

  it('enforces a single GraphQL-owned writer per native session', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.events.push(`data: ${JSON.stringify({ id: 'evt_busy', type: 'session.status', properties: { sessionID: 'ses_test', status: { type: 'busy' } } })}\n\n`)
    const first = native.startTurn(session, { prompt: 'first', clientCorrelationId: 'first' })[Symbol.asyncIterator]()
    await expect(first.next()).resolves.toMatchObject({ value: { type: 'session.status' }, done: false })
    const second = native.startTurn(session, { prompt: 'second', clientCorrelationId: 'second' })[Symbol.asyncIterator]()
    await expect(second.next()).rejects.toMatchObject({ result: { error: { code: 'OPENCODE_SESSION_BUSY' } } })
    await first.return?.()
  })

  it('captures exact permission payloads and maps opaque options to once, always, and reject', async () => {
    for (const [semantic, reply] of [['approve_once', 'once'], ['provider_scoped_allow', 'always'], ['reject', 'reject']] as const) {
      const server = new FakeServer()
      const native = manager(server)
      const session = await sessionFor(native)
      server.permissions = [{
        id: 'per_one', sessionID: 'ses_test', permission: 'bash', patterns: ['pnpm test'], metadata: { command: 'pnpm test' },
        always: ['pnpm test*'], tool: { messageID: 'msg_tool', callID: 'call_tool' },
      }]
      const pending = await native.pending(session)
      expect(pending?.request).toEqual({
        id: 'per_one', sessionID: 'ses_test', permission: 'bash', patterns: ['pnpm test'], metadata: { command: 'pnpm test' },
        always: ['pnpm test*'], tool: { messageID: 'msg_tool', callID: 'call_tool' },
      })
      const option = pending?.responseOptions.find((item) => item.semantic === semantic)
      expect(option).toBeDefined()
      await native.respond(session, 'per_one', option!)
      const response = server.calls.find((call) => call.path.startsWith('/permission/per_one/reply'))
      expect(JSON.parse(String(response?.init?.body))).toEqual({ reply })
      if (semantic === 'reject') expect(option).toMatchObject({ affectsOtherPendingRequests: true, persistence: 'request' })
      if (semantic === 'provider_scoped_allow') expect(option).toMatchObject({ persistence: 'provider_instance', mutatesPersistentPolicy: false })
    }
  })

  it('rejects forged options and reports an uncertain post-dispatch transport failure', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.permissions = [{ id: 'per_one', sessionID: 'ses_test', permission: 'read', patterns: ['*'], metadata: {}, always: ['*'] }]
    const pending = await native.pending(session)
    const valid = pending!.responseOptions[0]!
    await expect(native.respond(session, 'per_one', { ...valid, label: 'forged' })).rejects.toMatchObject({ certainty: 'definite' })
    server.failNextMutation = true
    await expect(native.respond(session, 'per_one', valid)).rejects.toBeInstanceOf(OpenCodeNativeDeliveryError)
    await expect(native.respond(session, 'per_one', valid)).resolves.toBeUndefined()
  })

  it('exposes every same-session pending request so reject cascades reconcile all rows', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.permissions = [
      { id: 'per_one', sessionID: 'ses_test', permission: 'read', patterns: ['a'], metadata: {}, always: ['a'] },
      { id: 'per_two', sessionID: 'ses_test', permission: 'bash', patterns: ['b'], metadata: {}, always: ['b'] },
      { id: 'per_other', sessionID: 'ses_other', permission: 'read', patterns: ['c'], metadata: {}, always: ['c'] },
    ]
    const before = await native.pendingAll(session)
    expect(before.map((item) => item.turn.nativeRequestId)).toEqual(['per_one', 'per_two'])
    await native.respond(session, 'per_one', before[0]!.responseOptions.find((item) => item.semantic === 'reject')!)
    expect(await native.pendingAll(session)).toEqual([])
  })

  it('aborts then clears stale approval waits only in the target session', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.permissions = [
      { id: 'per_one', sessionID: 'ses_test', permission: 'bash', patterns: ['a'], metadata: {}, always: ['a'] },
      { id: 'per_other', sessionID: 'ses_other', permission: 'bash', patterns: ['b'], metadata: {}, always: ['b'] },
    ]
    expect(await native.cancel(session)).toBe(true)
    expect(await native.pendingAll(session)).toEqual([])
    expect(server.calls.some((call) => call.path.startsWith('/session/ses_test/abort'))).toBe(true)
    expect(server.calls.some((call) => call.path.startsWith('/permission/per_one/reply'))).toBe(true)
  })

  it('uses native abort and exposes precise resolved MCP evidence without secrets', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.config = {
      mcp: { 'graphql-app': { type: 'remote', url: 'http://127.0.0.1:4100/mcp/app', oauth: false, headers: { authorization: 'Bearer opaque' } } },
      permission: [{ permission: 'graphql-app_*', pattern: '*', action: 'ask' }],
    }
    server.mcpEvidence = { name: 'graphql-app', enabled: true, transport: 'streamable-http', endpoint: 'http://127.0.0.1:4100/mcp/app', credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN' }
    server.mcp = { 'graphql-app': { status: 'connected' } }
    expect(await native.cancel(session)).toBe(true)
    await expect(native.inspectNativeMcp('/workspace/project')).resolves.toMatchObject({
      cwd: '/workspace/project', providerVersion: '1.18.31', nativeStatus: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN',
      effectiveFilters: [],
    })
    await expect(native.inspectMcp()).resolves.toMatchObject({ state: 'connected', endpointMatches: true })
    server.mcp = {}
    await expect(native.inspectNativeMcp('/workspace/project')).resolves.toMatchObject({ nativeStatus: 'status_unavailable' })
  })

  it('preserves ordered Advanced permission rules and applies only preconfigured MCP controls', async () => {
    const server = new FakeServer()
    server.config = { mcp: { 'graphql-app': { type: 'remote' }, 'disabled-app': { type: 'remote' } } }
    const executionRequest = request()
    if (executionRequest.configuration.harness.harness !== 'opencode') throw new Error('fixture mismatch')
    executionRequest.configuration.harness.advanced = {
      ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
      permissionRules: [
        { permission: 'shell', pattern: '*', effect: 'ask' },
        { permission: 'shell', pattern: 'git status', effect: 'allow' },
        { permission: 'subagent', pattern: 'general', effect: 'deny' },
      ],
      mcp: { serverEnabled: { 'graphql-app': true, 'disabled-app': false } },
    }
    const native = manager(server)
    await sessionFor(native, executionRequest)
    const create = server.calls.find((call) => call.path.startsWith('/session') && call.init?.method === 'POST')
    expect(JSON.parse(String(create?.init?.body)).permission).toEqual([
      { permission: 'bash', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git status', action: 'allow' },
      { permission: 'task', pattern: 'general', action: 'deny' },
    ])
    expect(server.calls.some((call) => call.path.startsWith('/mcp/graphql-app/connect'))).toBe(true)
    expect(server.calls.some((call) => call.path.startsWith('/mcp/disabled-app/disconnect'))).toBe(true)
  })

  it('merges compaction settings without flattening unrelated native config', () => {
    const content = buildOpenCodeConfigContent(JSON.stringify({ model: 'kept/model', compaction: { custom: true }, plugin: ['kept'] }), {
      ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
      subagentDepth: 0,
      compaction: { auto: false, prune: true, tailTurns: 4, preserveRecentTokens: 2048 },
    })
    expect(JSON.parse(content)).toEqual({
      model: 'kept/model', plugin: ['kept'], subagent_depth: 0,
      compaction: { custom: true, auto: false, prune: true, tail_turns: 4, preserve_recent_tokens: 2048 },
    })
  })

  it('uses the explicit application Operator working directory without a cwd fallback', async () => {
    const server = new FakeServer()
    const native = manager(server)
    await native.createSession({
      kind: 'operator', correlationId: 'conversation-1', workingDirectory: '/runtime/operator',
      configuration: {
        id: 'operator-config-1', operatorId: 'agent-1', version: 1,
        harness: request().configuration.harness,
        contentHash: 'sha256:operator', createdAt: '2026-09-16T00:00:00.000Z',
      },
      environment: { agentId: 'agent-1', variables: {} },
    })
    expect(server.calls.some((call) => call.path === '/session?directory=%2Fruntime%2Foperator')).toBe(true)
    expect(server.calls.some((call) => call.path.includes(encodeURIComponent(process.cwd())))).toBe(false)
  })

  it('reattaches exact persisted identity after manager restart and never creates a replacement', async () => {
    const server = new FakeServer()
    const first = manager(server)
    const executionRequest = request()
    const session = await sessionFor(first, executionRequest)
    const createsBefore = server.calls.filter((call) => call.path.startsWith('/session?') && call.init?.method === 'POST').length

    const restarted = manager(server)
    await expect(restarted.attachSession(session, { request: executionRequest })).resolves.toEqual(session)
    expect(server.calls.filter((call) => call.path.startsWith('/session?') && call.init?.method === 'POST')).toHaveLength(createsBefore)
    expect(server.calls.some((call) => call.path === '/session/ses_test?directory=%2Fworkspace%2Fproject')).toBe(true)

    const missing = manager(server)
    server.sessionExists = false
    await expect(missing.attachSession(session, { request: executionRequest })).rejects.toMatchObject({
      result: { error: { code: 'OPENCODE_SESSION_NOT_FOUND' } },
    })
    expect(server.calls.filter((call) => call.path.startsWith('/session?') && call.init?.method === 'POST')).toHaveLength(createsBefore)
  })
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function sse(text: string): Response {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

async function expectProcessExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Process ${pid} was still alive after server disposal.`)
}
