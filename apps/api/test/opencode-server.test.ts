import { describe, expect, it } from 'vitest'

import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type HarnessExecutionRequest } from '@graphql/contracts'

import {
  OpenCodeNativeDeliveryError,
  OpenCodeNativeSessionManager,
  buildOpenCodeConfigContent,
  type OpenCodeServerController,
} from '../src/modules/harnesses/opencodeServer.js'

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

  async ensure() {}
  async dispose() {}
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
    if (route === '/session' && method === 'POST') return json({ id: 'ses_test' })
    if (route === '/event') { this.eventStreams += 1; return sse(this.events.shift() ?? '') }
    if (route === '/permission') return json(this.permissions)
    if (route === '/session/ses_test/message') return json(this.eventStreams >= this.messagesAfterEventStreams ? this.messages : [])
    if (route === '/permission/per_one/reply' || route === '/permission/per_two/reply') {
      const reply = JSON.parse(String(init?.body)).reply
      const requestID = route.split('/')[2]
      this.permissions = reply === 'reject' ? [] : this.permissions.filter((item) => (item as { id?: string }).id !== requestID)
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

  it('reconnects a dropped SSE stream and deduplicates provider events', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.messagesAfterEventStreams = 2
    server.events.push(
      `data: ${JSON.stringify({ id: 'evt_duplicate', type: 'message.updated', properties: { sessionID: 'ses_test', info: {} } })}\n\n`,
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

  it('uses native abort and exposes precise resolved MCP evidence without secrets', async () => {
    const server = new FakeServer()
    const native = manager(server)
    const session = await sessionFor(native)
    server.config = {
      mcp: { 'graphql-app': { type: 'remote', url: 'http://127.0.0.1:4100/mcp/app', headers: { authorization: '{env:GRAPHQL_APP_MCP_TOKEN}' } } },
      permission: [{ permission: 'graphql-app_*', pattern: '*', action: 'ask' }],
    }
    server.mcp = { 'graphql-app': { status: 'connected' } }
    expect(await native.cancel(session)).toBe(true)
    await expect(native.inspectNativeMcp('/workspace/project')).resolves.toMatchObject({
      cwd: '/workspace/project', providerVersion: '1.18.31', nativeStatus: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN',
      effectiveFilters: [{ permission: 'graphql-app_*', pattern: '*', effect: 'ask' }],
    })
    await expect(native.inspectMcp()).resolves.toMatchObject({ state: 'connected', endpointMatches: true })
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
