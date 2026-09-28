import assert from 'node:assert/strict'

import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type HarnessExecutionRequest, type OpenCodeHarnessConfiguration } from '@graphql/contracts'

import { OpenCodeNativeDeliveryError, OpenCodeNativeSessionManager, type OpenCodeServerController } from '../src/modules/harnesses/opencodeServer.js'
import { childEnvironmentFingerprint } from '../src/modules/harnesses/opencodeTransport.js'
import type { NativeMcpEntryEvidence } from '../src/modules/harnesses/mcpDetection.js'
import { nativeMessageId, nativePolicy, object, type JsonObject, type OpenCodeMessage } from '../src/modules/harnesses/opencodeProtocol.js'
import type { ChildProcessEnvironment } from '../src/modules/harnesses/port.js'

export const requiredPaths = Object.fromEntries([
  '/session', '/session/status', '/session/{sessionID}', '/session/{sessionID}/message',
  '/session/{sessionID}/message/{messageID}', '/session/{sessionID}/prompt_async', '/session/{sessionID}/abort',
  '/permission', '/permission/{requestID}/reply', '/question', '/question/{requestID}/reject', '/event', '/config', '/mcp',
].map((path) => [path, {}]))

export function configuration(): OpenCodeHarnessConfiguration {
  return { harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', variant: 'max', nativeAgent: 'build', thinking: false, autoApprove: false }
}
export function request(harness = configuration()): HarnessExecutionRequest {
  return {
    executionId: 'execution-1', runId: 'run-1', workspaceId: 'workspace-1', workflowNodeId: 'node-1',
    workingDirectory: '/workspace/project', runtimeDirectory: '/workspace/project', input: {},
    configuration: { id: 'config-opencode', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
      prompt: { system: 'Test' }, assignedSkills: [], harness, contentHash: 'sha256:test', createdAt: '2026-09-16T00:00:00.000Z' },
  }
}
export function advanced() { return structuredClone(DEFAULT_OPENCODE_ADVANCED_CONFIGURATION) }
export function environment(token = 'fixture-owner-token'): ChildProcessEnvironment {
  return { agentId: 'agent-1', variables: { GRAPHQL_MCP_TOKEN: token } }
}
export function manager(server: FixtureServer) {
  return new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1', appMcpServerName: 'graphql', expectedAppMcpEndpoint: 'http://127.0.0.1:4100/mcp/app' })
}
export async function sessionFor(native: OpenCodeNativeSessionManager, harness = configuration()) {
  return native.createSession({ request: request(harness), environment: environment() })
}
export function errorCode(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.equal(object(error).code ?? object(object(object(error).result).error).code, code)
    return true
  }
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
}
export function brokenBody(status = 200): Response {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"accepted":'))
    controller.error(new Error('fixture body disconnected after headers'))
  } }), { status })
}
export function permission(id: string, sessionID = 'ses_test'): JsonObject {
  return { id, sessionID, permission: 'bash', patterns: ['pnpm test'], metadata: { command: 'pnpm test' },
    always: ['pnpm test*'], tool: { messageID: 'msg_tool', callID: 'call_tool' } }
}

/** API fixture uses V1 message identities, finish reasons, sparse status and open SSE streams. */
export class FixtureServer implements OpenCodeServerController {
  expectedVersion = '1.18.31'
  generation = 0
  environment: ChildProcessEnvironment | undefined
  readonly calls: { path: string; method: string; body?: JsonObject }[] = []
  readonly sessionInfos = new Map<string, JsonObject>()
  readonly messages = new Map<string, OpenCodeMessage[]>()
  readonly statuses = new Map<string, JsonObject>()
  readonly restartEnvironments: ChildProcessEnvironment[] = []
  mcpCredentialReferences: Record<string, string> = {}
  config: JsonObject = {}
  mcp: JsonObject = {}
  providers: unknown = { all: [{ id: 'opencode-go', models: { 'deepseek-v4.1-flash': { variants: { max: {} } } } }] }
  agents: unknown = [{ name: 'build' }, { name: 'plan' }]
  paths: JsonObject = requiredPaths
  permissions: JsonObject[] = []
  questions: JsonObject[] = []
  disposals = 0
  connections = 0
  cancelledSubscriptions = 0
  failConnections = 0
  crashed = false
  nextSessionIds: string[] = []
  beforeRequest: ((path: string, init: RequestInit) => Promise<Response | undefined> | Response | undefined) | undefined
  beforeRestart: (() => Promise<void>) | undefined
  onPrompt: ((sessionID: string, body: JsonObject) => Promise<void> | void) | undefined
  onConnection: ((number: number) => void) | undefined
  private clock = 1_000_000
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>()

  get credentialEnvironmentFingerprint(): string | undefined {
    return this.environment ? childEnvironmentFingerprint(this.environment) : undefined
  }
  async inspectMcpConfiguration(_directory: string, serverName: string): Promise<NativeMcpEntryEvidence | undefined> {
    const entry = object(object(this.config.mcp)[serverName])
    if (!Object.keys(entry).length) return undefined
    const status = object(this.mcp[serverName]).status
    const normalizedStatus: NativeMcpEntryEvidence['status'] = status === 'needs_auth'
      ? 'authentication_required' : status === 'failed' ? 'broken'
        : status === 'connected' || status === 'disabled' || status === 'authentication_required'
          || status === 'broken' || status === 'status_unavailable' ? status : undefined
    return {
      name: serverName,
      transport: entry.type === 'remote' ? 'streamable-http' : entry.type === 'local' ? 'stdio' : 'unknown',
      ...(typeof entry.url === 'string' ? { endpoint: entry.url } : {}),
      enabled: entry.enabled !== false,
      ...(this.mcpCredentialReferences[serverName]
        ? { credentialEnvironmentVariable: this.mcpCredentialReferences[serverName] } : {}),
      ...(normalizedStatus !== undefined ? { status: normalizedStatus } : {}),
    }
  }
  async ensure(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.crashed) { this.crashed = false; this.generation += 1; this.resetInstance() }
  }
  async dispose() { this.disposals += 1; this.closeStreams(); this.environment = undefined }
  async restart(environment: ChildProcessEnvironment) {
    await this.beforeRestart?.()
    this.environment = structuredClone(environment)
    this.restartEnvironments.push(structuredClone(environment))
    this.generation += 1
    this.resetInstance()
  }
  private resetInstance() {
    this.statuses.clear()
    this.permissions = []
    this.questions = []
    this.mcp = Object.fromEntries(Object.entries(object(this.config.mcp)).map(([name, config]) => [name, { status: object(config).enabled === false ? 'disabled' : 'connected' }]))
  }
  addSession(id: string, parentID?: string, harness = configuration(), directory = '/workspace/project') {
    const [providerID, ...model] = harness.model.split('/')
    this.sessionInfos.set(id, { id, directory, ...(parentID ? { parentID } : {}), agent: harness.nativeAgent,
      model: { providerID, id: model.join('/'), ...(harness.variant ? { variant: harness.variant } : {}) }, permission: nativePolicy(harness) })
    this.messages.set(id, [])
  }
  user(correlation: string, text = 'hello', sessionID = 'ses_test'): OpenCodeMessage {
    const id = nativeMessageId(correlation)
    const message: OpenCodeMessage = { info: { id, sessionID, role: 'user', agent: 'build', model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }, time: { created: this.clock++ } },
      parts: [{ id: `prt_${this.clock++}`, sessionID, messageID: id, type: 'text', text }] }
    this.append(message)
    return message
  }
  assistant(parentID: string, text = 'done', finish: string | undefined = 'stop', completed = true, sessionID = 'ses_test'): OpenCodeMessage {
    const id = `msg_assistant_${this.clock++}`
    const message: OpenCodeMessage = { info: { id, sessionID, role: 'assistant', parentID,
      time: { created: this.clock++, ...(completed ? { completed: this.clock++ } : {}) }, ...(finish ? { finish } : {}) },
      parts: [{ id: `prt_${this.clock++}`, sessionID, messageID: id, type: 'text', text }] }
    this.append(message)
    return message
  }
  append(message: OpenCodeMessage) {
    const id = String(message.info.sessionID)
    const messages = this.messages.get(id) ?? []
    messages.push(message)
    this.messages.set(id, messages)
  }
  complete(correlation: string, text = 'done', sessionID = 'ses_test') {
    const message = this.assistant(nativeMessageId(correlation), text, 'stop', true, sessionID)
    this.statuses.delete(sessionID)
    this.emit('message.updated', { info: message.info })
    for (const part of message.parts) this.emit('message.part.updated', { part })
    this.emit('session.idle', { sessionID })
    return message
  }
  emit(type: string, properties: JsonObject, id?: string) {
    this.emitBytes(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties, ...(id ? { id } : {}) })}\n\n`))
  }
  emitBytes(bytes: Uint8Array) { for (const stream of this.streams) stream.enqueue(bytes) }
  closeStreams() { for (const stream of this.streams) stream.close(); this.streams.clear() }

  async request(path: string, init: RequestInit = {}, signal?: AbortSignal, expectedGeneration?: number): Promise<Response> {
    await this.ensure(signal)
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) throw new OpenCodeNativeDeliveryError('OPENCODE_SERVER_GENERATION_CHANGED', 'fixture generation changed', 'definite')
    const url = new URL(path, 'http://fixture.invalid')
    const route = url.pathname
    const method = init.method ?? 'GET'
    const body = init.body ? object(JSON.parse(String(init.body))) : undefined
    this.calls.push({ path, method, ...(body ? { body } : {}) })
    const replacement = await this.beforeRequest?.(path, init)
    if (replacement) return replacement
    if (route === '/global/health') return json({ healthy: true, version: '1.18.31' })
    if (route === '/doc') return json({ paths: this.paths })
    if (route === '/provider') return json(this.providers)
    if (route === '/agent') return json(this.agents)
    if (route === '/config') return json(this.config)
    if (route === '/mcp') return json(this.mcp)
    if (/^\/mcp\/[^/]+\/(connect|disconnect)$/.test(route)) {
      const name = decodeURIComponent(route.split('/')[2]!)
      this.mcp[name] = { status: route.endsWith('/disconnect') ? 'disabled' : 'connected' }
      return json(true)
    }
    if (route === '/session/status') return json(Object.fromEntries(this.statuses))
    if (route === '/session' && method === 'POST') {
      const id = this.nextSessionIds.shift() ?? (this.sessionInfos.size ? `ses_${this.sessionInfos.size + 1}` : 'ses_test')
      this.sessionInfos.set(id, { ...body, id, directory: url.searchParams.get('directory') })
      this.messages.set(id, [])
      return json(this.sessionInfos.get(id))
    }
    if (route === '/permission') return json(this.permissions)
    if (/^\/permission\/[^/]+\/reply$/.test(route)) {
      const id = decodeURIComponent(route.split('/')[2]!)
      const request = this.permissions.find((item) => item.id === id)
      if (!request) return json({ error: 'missing request' }, 404)
      this.permissions = body?.reply === 'reject' ? this.permissions.filter((item) => item.sessionID !== request.sessionID) : this.permissions.filter((item) => item.id !== id)
      return json(true)
    }
    if (route === '/question') return json(this.questions)
    if (/^\/question\/[^/]+\/reject$/.test(route)) {
      const id = decodeURIComponent(route.split('/')[2]!)
      this.questions = this.questions.filter((item) => item.id !== id)
      return json(true)
    }
    if (route === '/event') {
      this.connections += 1
      if (this.failConnections > 0) { this.failConnections -= 1; throw new Error('fixture connection refused') }
      let active: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => { active = controller; this.streams.add(controller) },
        cancel: () => { this.streams.delete(active); this.cancelledSubscriptions += 1 },
      })
      this.onConnection?.(this.connections)
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    const segments = route.split('/').filter(Boolean).map(decodeURIComponent)
    if (segments[0] === 'session' && segments[1]) {
      const id = segments[1]
      const session = this.sessionInfos.get(id)
      if (!session) return json({ error: 'missing session' }, 404)
      if (segments.length === 2 && method === 'GET') return json(session)
      if (segments[2] === 'message' && segments[3]) {
        const message = (this.messages.get(id) ?? []).find((item) => item.info.id === segments[3])
        return message ? json(message) : json({ error: 'missing message' }, 404)
      }
      if (segments[2] === 'message') {
        const messages = this.messages.get(id) ?? []
        const limit = Number(url.searchParams.get('limit'))
        assert(limit > 0, 'Manager must use bounded native history pages')
        const cursor = url.searchParams.get('before')
        const end = cursor ? Number(cursor.replace('opaque-page:', '')) : messages.length
        const start = Math.max(0, end - limit)
        return json(messages.slice(start, end), 200, start > 0 ? { 'x-next-cursor': `opaque-page:${start}` } : {})
      }
      if (segments[2] === 'prompt_async') {
        assert(body)
        const messageID = String(body.messageID)
        // Native OpenCode stores a turn's system text on its user message.
        const message: OpenCodeMessage = { info: { id: messageID, sessionID: id, role: 'user', agent: body.agent, model: body.model,
          ...(typeof body.system === 'string' ? { system: body.system } : {}), time: { created: this.clock++ } },
          parts: (body.parts as JsonObject[]).map((part) => ({ ...part, id: `prt_${this.clock++}`, sessionID: id, messageID })) }
        this.append(message)
        this.statuses.set(id, { type: 'busy' })
        this.emit('message.updated', { info: message.info })
        await this.onPrompt?.(id, body)
        return new Response(null, { status: 204 })
      }
      if (segments[2] === 'abort') { this.statuses.delete(id); return json(true) }
      if (segments[2] === 'children') return json([...this.sessionInfos.values()].filter((item) => item.parentID === id))
    }
    return json({ error: 'unknown fixture route' }, 404)
  }
}
