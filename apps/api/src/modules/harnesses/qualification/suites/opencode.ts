import { qualifyOpenCodeSubagentInput } from './opencodeSubagentInput.js'
import { closeQualificationResources } from '../cleanup.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { File, FileRevision } from '@foreman-code/contracts/files'
import { registerFileToolsMcp, type FileMcpService } from '../../../files/tools/mcp.js'
import type { FileToolContext } from '../../../files/tools/types.js'
import { ManagedOpenCodeServer } from '../../opencodeTransport.js'
import { collectChecks, nonempty, object, requireCondition, type Check } from './checks.js'
import type { QualificationSuite } from '../types.js'


const requiredPaths = ['/session', '/session/status', '/session/{sessionID}', '/session/{sessionID}/message',
  '/session/{sessionID}/message/{messageID}', '/session/{sessionID}/prompt_async', '/session/{sessionID}/abort',
  '/permission', '/permission/{requestID}/reply', '/question', '/question/{requestID}/reject', '/event', '/config', '/mcp']

export const opencodeQualificationSuite: QualificationSuite = {
  harness: 'opencode', revision: 'opencode-live-6',
  async run(input: NativeQualificationSuiteInput) {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)])
    const server = new ManagedOpenCodeServer({
      binary: input.binary, workingDirectory: input.workDirectory,
      ...(input.processRecovery ? { processRecovery: input.processRecovery } : {}),
      ...(input.assertInstallation ? { assertInstallation: input.assertInstallation } : {}),
      ownerAgentId: 'qualification', appMcpAccess: 'none', startupTimeoutMs: 30_000,
    })
    const app = Fastify({ logger: false })
    const releaseServer = input.ownCleanup?.(() => server.dispose())
    const releaseApp = input.ownCleanup?.(() => app.close())
    const evidence: Record<string, unknown> = { profile: input.profile, binarySha256: input.binarySha256, model: input.model }
    const nativeTurns: Array<{ messageId: string; messages: unknown }> = []
    const fileRequests: Array<{ method: string; body: unknown; statusCode?: number }> = []
    const fileResponses: Array<{ tool: string; value: unknown }> = []
    evidence.nativeTurns = nativeTurns
    evidence.fileMcpRequests = fileRequests
    evidence.fileMcpResponses = fileResponses
    let sessionId: string | undefined
    let mcpName: string | undefined
    let mcpReady = false
    let read = false, published = false
    const publicationErrors: Array<{ code: string | null; message: string }> = []
    evidence.filePublicationErrors = publicationErrors
    const marker = `QUALIFY_${randomUUID()}`
    const sourcePath = join(input.workDirectory, 'qualification-source.md')
    const outputPath = join(input.workDirectory, 'qualification-result.md')
    const scope: FileToolContext['scope'] = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'qualification',
      agentId: 'qualification', workspaceId: 'qualification', workflowId: 'qualification' } }
    const context: FileToolContext = { ownerPrincipalId: 'qualification', scope, nativeSessionId: 'qualification',
      turnId: 'qualification', allowMutation: true, allowedTools: ['files.read', 'files.publish_result'] }
    const token = `gql_file_${randomBytes(32).toString('base64url')}`
    const redact = <T>(value: T): T => server.redactWithAdditionalSecrets(value, [token])
    const observedRequests = new Map<string, typeof fileRequests[number]>()
    app.addHook('preHandler', async (request) => {
      const observed = { method: request.method, body: redact(request.body) }
      fileRequests.push(observed)
      observedRequests.set(request.id, observed)
    })
    app.addHook('onResponse', async (request, reply) => {
      const observed = observedRequests.get(request.id)
      if (observed) observed.statusCode = reply.statusCode
      observedRequests.delete(request.id)
    })
    const sourceId = randomUUID(), sourceRevisionId = randomUUID(), outputId = randomUUID(), outputRevisionId = randomUUID()
    const now = new Date().toISOString(), expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString()
    const sourceBytes = Buffer.from(`# Qualification\n\n${marker}\n`)
    const sourceFile: File = { fileId: sourceId, currentRevisionId: sourceRevisionId, createdAt: now,
      scope, state: 'ready', retentionDurationSeconds: 3600, expiresAt }
    const sourceRevision: FileRevision = { fileId: sourceId, revisionId: sourceRevisionId, filename: 'qualification-source.md',
      mediaType: 'text/markdown', byteSize: sourceBytes.length, sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      origin: 'upload', createdAt: now }
    const fileService = {
      sessions: { authenticate: async (candidate: string | undefined, tool?: string) => {
        requireCondition(candidate === token && (!tool || context.allowedTools.includes(tool as typeof context.allowedTools[number])),
          'Invalid qualification file credential or tool.')
        return { context }
      } },
      list: async () => { throw new Error('files.list is not enabled.') },
      read: async (_token: string, request: { fileId: string; revisionId: string; offset: number; length: number }) => {
        requireCondition(request.fileId === sourceId && request.revisionId === sourceRevisionId, 'Wrong source pin.')
        read = true
        const bytes = sourceBytes.subarray(request.offset, request.offset + request.length)
        const result = { status: 'ready' as const, file: sourceFile, revision: sourceRevision, readAt: new Date().toISOString(),
          offset: request.offset, byteLength: bytes.length, contentBase64: bytes.toString('base64'),
          eof: request.offset + bytes.length === sourceBytes.length }
        fileResponses.push({ tool: 'files.read', value: result })
        return result
      },
      createWorkingCopy: async () => { throw new Error('files.create_working_copy is not enabled.') },
      publish: async (_token: string, request: { artifactId: string; scope: FileToolContext['scope']; filename: string; mediaType: string }) => {
        try {
          requireCondition(request.artifactId === 'qualification-result' && request.filename === 'qualification-result.md'
            && request.mediaType === 'text/markdown' && JSON.stringify(request.scope) === JSON.stringify(scope), 'Wrong publication target.')
          const bytes = await readFile(outputPath)
          requireCondition(bytes.toString('utf8').includes(marker) && bytes.toString('utf8').includes('QUALIFIED'),
            'Published Markdown does not contain the source marker and edit.')
          published = true
          const createdAt = new Date().toISOString()
          const result = { value: { file: { fileId: outputId, currentRevisionId: outputRevisionId, createdAt,
            scope, state: 'ready' as const, retentionDurationSeconds: 3600,
            expiresAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString() },
          revision: { fileId: outputId, revisionId: outputRevisionId, filename: 'qualification-result.md',
            mediaType: 'text/markdown' as const, byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'agent_output' as const, createdAt } }, replayed: false }
          fileResponses.push({ tool: 'files.publish_result', value: result })
          return result
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null
          const message = error instanceof Error ? error.message : String(error)
          publicationErrors.push({ code, message })
          throw error
        }
      },
    } as unknown as FileMcpService
    registerFileToolsMcp(app, fileService)
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const url = `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(input.workDirectory)}`
      const response = await server.request(url, { method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }, signal)
      requireCondition(response.ok, `OpenCode ${path} returned HTTP ${response.status}.`)
      const text = await response.text()
      return text ? JSON.parse(text) as unknown : undefined
    }
    const createSession = async () => {
      const session = object(await request('/session', { title: 'Harness qualification', permission: [
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'graphql_files_*', pattern: '*', action: 'allow' },
      ] }))
      sessionId = nonempty(session.id, 'session ID')
      evidence.sessionId = sessionId
    }
    const turn = async (prompt: string) => {
      requireCondition(sessionId, 'OpenCode session is unavailable.')
      const messageID = `msg_${randomUUID().replaceAll('-', '')}`
      const sessionPath = `/session/${encodeURIComponent(sessionId)}`
      const model = input.model?.split('/')
      requireCondition(!input.model || (model && model.length >= 2 && model[0] && model.slice(1).join('/')),
        'OpenCode model must be provider/model.')
      await request(`${sessionPath}/prompt_async`, { messageID, agent: 'build',
        ...(model ? { model: { providerID: model[0], modelID: model.slice(1).join('/') } } : {}),
        parts: [{ type: 'text', text: prompt }] })
      const observed = { messageId: messageID, messages: undefined as unknown }
      nativeTurns.push(observed)
      while (true) {
        signal.throwIfAborted()
        const messages = await request(`${sessionPath}/message`) as { info?: { role?: string; parentID?: string; finish?: string; error?: unknown; providerID?: string; modelID?: string; time?: { completed?: number } } }[]
        observed.messages = redact(messages)
        const terminal = messages.find((message) => message.info?.role === 'assistant' && message.info.parentID === messageID
          && (message.info.error || (typeof message.info.time?.completed === 'number'
            && message.info.finish !== undefined && message.info.finish !== 'tool-calls')))
        if (terminal) {
          requireCondition(!terminal.info?.error && typeof terminal.info?.time?.completed === 'number', 'Native turn failed.')
          if (terminal.info.providerID && terminal.info.modelID) evidence.modelUsed = `${terminal.info.providerID}/${terminal.info.modelID}`
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    const checks: Check[] = [
      ['binary-sha256', async () => {
        const actual = createHash('sha256').update(await readFile(input.binary)).digest('hex')
        requireCondition(actual === input.binarySha256, 'OpenCode binary SHA-256 differs from the requested candidate.')
        return actual
      }],
      ['server-health', async () => {
        await server.ensure(signal)
        const health = object(await request('/global/health'))
        requireCondition(health.healthy === true && health.version === input.version, 'OpenCode health/version mismatch.')
        evidence.version = health.version
        return `Healthy OpenCode ${input.version}`
      }],
      ['openapi-paths', async () => {
        const doc = object(await request('/doc'))
        const paths = object(doc.paths)
        const missing = requiredPaths.filter((path) => !Object.hasOwn(paths, path))
        requireCondition(missing.length === 0, `OpenAPI paths missing: ${missing.join(', ')}`)
        evidence.openapiPaths = requiredPaths.length
        return `${requiredPaths.length} application paths present.`
      }],
      ['session-create', async () => {
        await createSession()
        return 'Native session created.'
      }],
      ['text-turn', async () => {
        evidence['text-turnAttempts'] = 1
        await turn('Reply with a short sentence confirming this qualification text turn. Do not call tools.')
        return 'Asynchronous text turn completed.'
      }],
      ['subagent-input', async () => {
        requireCondition(sessionId, 'The qualification parent is unavailable.')
        evidence.subagentInput = await qualifyOpenCodeSubagentInput(request, sessionId, input.model)
        return 'Idle child input preserves native identity, agent, model, variant and system instructions.'
      }],
      ['mcp-file-tools', async () => {
        await writeFile(sourcePath, sourceBytes, { flag: 'wx', mode: 0o400 })
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        mcpName = `graphql_files_qualification_${randomUUID().replaceAll('-', '').slice(0, 12)}`
        await request('/mcp', { name: mcpName, config: { type: 'remote', url: `${address}/mcp/files`, enabled: true,
          oauth: false, headers: { Authorization: `Bearer ${token}` } } })
        mcpReady = true
        requireCondition(object(object(await request('/mcp'))[mcpName]).status === 'connected', 'File MCP did not connect.')
        evidence['mcp-file-toolsAttempts'] = 1
        await turn(`Use files.read with fileId ${sourceId} and revisionId ${sourceRevisionId} to read the Markdown marker. Write ${JSON.stringify(outputPath)} with that marker and the word QUALIFIED. Then call files.publish_result with artifactId qualification-result, commandId ${randomUUID()}, filename qualification-result.md, mediaType text/markdown, and scope ${JSON.stringify(scope)}. Do not use shell commands or other paths.`)
        requireCondition(read && published, 'Native turn did not complete MCP read and publication.')
        return 'MCP read and publication completed.'
      }],
    ]
    try { return await collectChecks({ ...input, signal }, checks, evidence) }
    finally {
      if (mcpReady && mcpName) await request(`/mcp/${encodeURIComponent(mcpName)}/disconnect`, {}).catch(() => undefined)
      await closeQualificationResources([
        { close: () => server.dispose(), release: releaseServer },
        { close: () => app.close(), release: releaseApp },
      ])
    }
  },
}
