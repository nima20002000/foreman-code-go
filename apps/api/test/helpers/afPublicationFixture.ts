import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { onTestFinished, expect } from 'vitest'
import { z } from 'zod'
import { DEFAULT_HARNESS_DEFAULTS, NativeHarnessEventSchema, type HarnessExecution, type NativeSessionReference } from '@graphql/contracts'
import type { SendAgentChatMessageRequest } from '@graphql/contracts/agent-chat'
import { MAX_FILE_BYTES, type FileRevision, type FileWithRevision, type MessageAttachmentRef } from '@graphql/contracts/files'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { AgentReferenceService } from '../../src/modules/files/references/agentService.js'
import { PostgresAgentReferenceAuthorization } from '../../src/modules/files/references/agentAuthorization.js'
import { PostgresReferenceReadRepository } from '../../src/modules/files/references/agentProvenance.js'
import { FileReferenceService } from '../../src/modules/files/references/service.js'
import { PostgresFileReferenceAuthorization } from '../../src/modules/files/references/authorization.js'
import { agentFileReferenceResolver } from '../../src/modules/files/tools/referenceResolver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { registerOperatorHttpSecurity } from '../../src/modules/access/http.js'
import { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository, agentChatCorrelation } from '../../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../../src/modules/files/postgres.js'
import { TemporaryFileService } from '../../src/modules/files/service.js'
import { FileByteStorage } from '../../src/modules/files/storage.js'
import { registerProductionFileTools } from '../../src/modules/files/tools/production.js'
import { postgresCodexChatFiles } from '../../src/modules/harnesses/codexFiles/chatAdmission.js'
import { productionCodexChatFiles, type CodexChatFileAdmission } from '../../src/modules/harnesses/codexFiles/production.js'
import type { CodexFileHostLease } from '../../src/modules/harnesses/codexFiles/port.js'
import { nativeMessageId } from '../../src/modules/harnesses/opencodeProtocol.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../../src/modules/harnesses/port.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { registerAgentChatRoutes } from '../../src/routes/agentChat.js'
import { agent3Database, candidateFor, deferred, seedAgent3 } from './wave25Agent3.js'

export const pin = (value: FileWithRevision): MessageAttachmentRef => ({ fileId: value.file.fileId, revisionId: value.revision.revisionId })
export async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('AF chat did not reach the expected state')
}

/** Only native I/O/host materialization are synthetic. The production bridge,
 * services, grants, files, byte storage, publication ledger and chat rows are real. */
class PausedNative implements NativeHarnessSessionManager {
  holdNext = false
  steerCalls = 0
  starts = 0
  onFinish: (() => Promise<void>) | undefined
  private gate: ReturnType<typeof deferred<void>> | undefined
  private histories = new Map<string, NativeHistory>()
  constructor(readonly harness: 'codex' | 'opencode') {}
  async capabilities() {
    return { provider: this.harness, providerVersion: 'fixture-1', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false,
      mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('unused') }
  async createSession(): Promise<NativeSessionReference> {
    return { harness: this.harness, providerVersion: 'fixture-1', nativeSessionId: randomUUID() }
  }
  async attachSession(session: NativeSessionReference) { return session }
  async forkSession() { return this.createSession() }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    this.starts++
    const id = this.harness === 'opencode' ? nativeMessageId(input.clientCorrelationId) : randomUUID()
    const history: NativeHistory = { correlationId: input.clientCorrelationId, nativeTurnId: id, events: [], pendingInteractions: [] }
    this.histories.set(input.clientCorrelationId, history)
    const gate = this.holdNext ? deferred() : undefined
    this.holdNext = false; this.gate = gate
    await input.onSubmitted?.(id)
    if (gate) await gate.promise
    await this.onFinish?.(); this.onFinish = undefined
    history.terminalResult = { outcome: 'succeeded' }
    yield NativeHarnessEventSchema.parse({ sequence: 1, type: 'item.completed', occurredAt: new Date().toISOString(),
      payload: { turnId: id, item: { id: randomUUID(), type: 'agentMessage', text: 'done', phase: 'final_answer' } } })
  }
  async steerTurn(_session: NativeSessionReference, input: { expectedTurnId: string }) {
    this.steerCalls++; return { nativeTurnId: input.expectedTurnId }
  }
  finish() { this.gate?.resolve(); this.gate = undefined }
  async pending() { return undefined }
  async respond() {}
  async cancel() { this.finish(); return true }
  async history() { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlation: string) {
    return this.histories.get(correlation) ?? { events: [], pendingInteractions: [] }
  }
  async close() { this.finish() }
}

export async function afPublicationFixture(harness: 'codex' | 'opencode' = 'codex', selectedRun = false) {
  const database = await agent3Database()
  const root = await mkdtemp(join(process.cwd(), '.af-publications-'))
  const project = join(root, 'project'), hostRoot = join(root, 'host')
  await Promise.all([mkdir(project), mkdir(hostRoot)])
  const app = Fastify()
  const natives = new Map<string, PausedNative>()
  onTestFinished(async () => {
    for (const native of natives.values()) native.finish()
    try { await agent?.shutdown(); await app.close() }
    finally { await database.close(); await rm(root, { recursive: true, force: true }) }
  })
  const seed = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential')
  for (const configuration of seed.configurations) configuration.harness = harness === 'codex'
    ? { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' }
    : { ...DEFAULT_HARNESS_DEFAULTS.opencode }
  const fixture = await seedAgent3(database.pool, project, seed, { run: selectedRun })
  const access = new PostgresAccessService(database.pool)
  const owner = await access.issue({ name: 'AF publication owner', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
  const reader = await access.issue({ name: 'AF reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
  const runExecution: HarnessExecution = { ...candidateFor(fixture), state: 'completed',
    nativeSessionId: 'publication-run-source', workingDirectory: project,
    result: { outcome: 'succeeded' }, finishedAt: fixture.createdAt }
  if (selectedRun) await database.pool.query(`insert into harness_executions
    (id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
  [runExecution.id, runExecution.runId, runExecution.workflowNodeId, runExecution.agentId, JSON.stringify(runExecution)])
  const repository = new PostgresAgentChatRepository(database.pool)
  const agent = new AgentChatService(database.pool, repository, new PostgresOperatorConversationRepository(database.pool),
    new PostgresWorkflowRepository(database.pool), { // Only source execution/native I/O is synthetic; Run/execution FK rows are real.
      getForWorkspace: async (workspaceId, runId) => selectedRun && workspaceId === fixture.scope.workspaceId && runId === fixture.run.id
        ? AcceptedWorkflowRunV3Schema.parse({ ...fixture.run, executionState: 'completed' }) : undefined,
      async *executionPages() { if (selectedRun) yield [runExecution] },
    },
    (id) => {
      let native = natives.get(id)
      if (!native) { native = new PausedNative(harness); natives.set(id, native) }
      return native
    }, join(root, 'runtime'))
  const chat = agent
  const fileRepository = new PostgresFileRepository(database.pool), bytes = new FileByteStorage(join(root, 'bytes'), MAX_FILE_BYTES)
  const files = new TemporaryFileService(fileRepository, bytes, new PostgresFileConversationAuthorization(database.pool))
  const references = new FileReferenceService(fileRepository, bytes, new PostgresFileReferenceAuthorization(database.pool),
    new PostgresCommandCoordinator(database.pool))
  const agentReferences = new AgentReferenceService({ files: fileRepository, bytes,
    authorization: new PostgresAgentReferenceAuthorization(database.pool), reads: new PostgresReferenceReadRepository(database.pool) })
  registerOperatorHttpSecurity(app, access)
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
    .send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_REQUEST' } }))
  registerAgentChatRoutes(app, chat)
  const service = registerProductionFileTools(app, database.pool, files, agentFileReferenceResolver(agentReferences, fileRepository, bytes))
  await app.ready()
  const node = fixture.version.definition.nodes[0]!
  const context = { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId,
    ...(selectedRun ? { runId: fixture.run.id } : {}) }
  const workspaceId = fixture.scope.workspaceId
  const request = (conversationId: string | null, changes: Partial<SendAgentChatMessageRequest> = {}): SendAgentChatMessageRequest => ({
    requestId: randomUUID(), content: 'review', context, intent: 'next_turn', expectedConversationId: conversationId, ...changes,
  })
  const created = await chat.send(owner.principal, workspaceId, request(null))
  const conversationId = created.state.conversation!.id
  const settle = () => waitFor(async () => !(await repository.get(conversationId))?.active_request_id
    && !(await repository.state(conversationId))?.turns.some((turn) => ['queued', 'submitting', 'accepted'].includes(turn.delivery)))
  await settle()
  const native = natives.get(conversationId)!
  const target = { kind: 'agent' as const, workspaceId, conversationId }
  async function upload(bytes = Buffer.from('# input\n'), filename = 'source.md', mediaType: FileRevision['mediaType'] = 'text/markdown') {
    const requestId = randomUUID()
    await files.allocate(owner.principal, target, { requestId, filename, mediaType, byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })
    await files.upload(owner.principal, target, requestId, Readable.from([bytes]))
    return pin((await files.finalize(owner.principal, target, requestId)).value)
  }
  async function inheritedReference(bytes = Buffer.from('# inherited workflow reference\n')) {
    const result = await references.add(owner.principal, { scope: { kind: 'workflow_reference',
      workspaceId, workflowId: fixture.scope.workflowId }, upload: { requestId: randomUUID(),
      filename: 'inherited.md', mediaType: 'text/markdown', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }, contentBase64: bytes.toString('base64') })
    return pin(result.value)
  }
  async function pause(attachments: MessageAttachmentRef[] = []) {
    native.holdNext = true
    const input = request(conversationId, { attachments })
    await chat.send(owner.principal, workspaceId, input)
    await waitFor(async () => !!(await repository.turn(conversationId, input.requestId))?.nativeTurnId)
    const turn = (await repository.turn(conversationId, input.requestId))!
    const row = (await repository.get(conversationId))!
    const session: NativeSessionReference = { harness, providerVersion: row.provider_version!, nativeSessionId: row.native_session_id! }
    return { input, turn, session, correlation: agentChatCorrelation(conversationId, input.requestId) }
  }
  const stored = async (messageId: string) => (await database.pool.query<{
    record: { attachmentRefs?: MessageAttachmentRef[]; publicationRefs?: MessageAttachmentRef[] }
  }>('select record from operator_conversation_messages where id=$1', [messageId])).rows[0]!.record
  const publications = async (messageId: string) => (await database.pool.query<{ file_id: string; revision_id: string }>(`
    select p.file_id,p.revision_id from file_tool_publications p join file_allocations a
      on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id and a.state='finalized'
    where p.record->'context'->>'messageId'=$1 order by p.request_id`, [messageId])).rows
    .map((row) => ({ fileId: row.file_id, revisionId: row.revision_id }))
  const hosts: { closed: boolean }[] = []
  const resolver = postgresCodexChatFiles(database.pool, () => files, async () => {
    const state = { closed: false }; hosts.push(state)
    const host: CodexFileHostLease = {
      executionHostId: 'af-host', pathStyle: 'posix',
      async materialize(input) {
        const chunks: Buffer[] = []; for await (const chunk of input.bytes) chunks.push(Buffer.from(chunk as Uint8Array))
        const bytes = Buffer.concat(chunks), registrationId = randomUUID()
        expect(bytes.length).toBe(input.byteSize)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256)
        return { registrationId, executionHostId: 'af-host', executionPath: join(hostRoot, registrationId, input.filename),
          writable: input.writable, byteSize: bytes.length, sha256: input.sha256 }
      },
      async sealCompleted() { throw new Error('Production editsOnly must not read writable host files') },
      async close() { state.closed = true },
    }
    return host
  }, hostRoot)
  async function prepareCodex(active: Awaited<ReturnType<typeof pause>>, alter?: (admission: CodexChatFileAdmission) => void) {
    const identity = { conversationId, session: active.session, clientCorrelationId: active.correlation, signal: new AbortController().signal }
    const admission = await resolver.resolve(identity)
    expect(admission).toBeDefined(); alter?.(admission!)
    const bridge = await productionCodexChatFiles(() => app, conversationId, { resolve: async () => admission }).prepare(identity)
    expect(bridge).toBeDefined()
    await bridge!.nativeInput(active.input.content)
    await bridge!.activate(active.turn.nativeTurnId!)
    native.onFinish = () => bridge!.close()
    return { bridge: bridge!, admission: admission! }
  }
  const readPins = async (messageId: string) => {
    // A fresh repository exercises ordinary restart/resume readback, not an in-memory result.
    const page = await new PostgresAgentChatRepository(database.pool).history(conversationId, undefined, 100)
    return page.messages.find((message) => message.id === messageId)?.attachments?.map(pin) ?? []
  }
  async function nextTurn() {
    const next = await pause([await upload()])
    if (harness === 'codex') { const { bridge } = await prepareCodex(next); await bridge.close() }
    native.finish(); await settle()
    return next
  }
  return { database, root, project, app, access, owner, reader, repository, chat, files, service, fixture,
    workspaceId, context, conversationId, native, request, upload, inheritedReference, references, pause, settle, stored, publications,
    resolver, hosts, prepareCodex, readPins, nextTurn, runExecution }
}
