import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES, type MessageAttachmentRef } from '@graphql/contracts/files'
import type { CodexFileCallResult } from '../src/modules/harnesses/codexFiles/port.js'
import { OpenCodeFileTurn } from '../src/modules/harnesses/opencodeFiles/turn.js'
import { adoptOpenCodePublications, resolveOpenCodeFileAdmission } from '../src/modules/harnesses/opencodeFiles/postgres.js'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { withAfMcp } from './helpers/afMcp.js'
import { AgentChatStateSchema } from '@graphql/contracts/agent-chat'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { createChatFileBackend } from './support/opencodeChatFileFixture.js'

const signal = () => AbortSignal.timeout(30_000)
function toolValue(result: CodexFileCallResult): { value: { artifactId: string; file: { fileId: string }; revision: { revisionId: string } } } {
  expect(result.success, JSON.stringify(result)).toBe(true)
  const text = result.contentItems.find((item) => item.type === 'inputText')
  if (!text || text.type !== 'inputText') throw new Error('File result has no JSON text')
  return JSON.parse(text.text)
}
const asPin = (result: ReturnType<typeof toolValue>): MessageAttachmentRef => ({
  fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId,
})
async function codex(f: Awaited<ReturnType<typeof afPublicationFixture>>, count: number,
  failure?: 'adopt_once' | 'revoke_after_finalize' | 'lose_close') {
  const attachments: MessageAttachmentRef[] = []
  for (let index = 0; index < count; index++) attachments.push(await f.upload(Buffer.from(`# input ${index}\n`)))
  // An inherited reference exists independently of this turn's upload inputs.
  const source = attachments[0] ?? await f.inheritedReference()
  const active = await f.pause(attachments)
  const { bridge, admission } = await f.prepareCodex(active, (admission) => {
    if (failure === 'adopt_once' || failure === 'lose_close') {
      const adopt = admission.adoptPublished
      let fail = true
      admission.adoptPublished = async (...args) => {
        if (fail) { fail = false; throw new Error('Injected transient adoption database failure') }
        return adopt(...args)
      }
    }
  })
  const call = (tool: string, arguments_: unknown) => bridge.call({ threadId: active.session.nativeSessionId,
    turnId: active.turn.nativeTurnId!, tool, arguments: arguments_ })
  const copy = toolValue(await call('files_create_working_copy', { commandId: randomUUID(), source,
    destination: admission.accepted.scope }))
  if (failure === 'revoke_after_finalize') {
    const finalize = f.files.finalize.bind(f.files)
    vi.spyOn(f.files, 'finalize').mockImplementation(async (...args) => {
      const result = await finalize(...args)
      // This is AFTER the real finalize transaction and BEFORE publish's final authentication.
      await f.database.pool.query(`update file_tool_sessions set revoked_at=clock_timestamp()
        where record->'context'->>'messageId'=$1`, [active.turn.messageId])
      return result
    })
  }
  const publish = () => call('files_publish_result', { commandId: randomUUID(), artifactId: copy.value.artifactId,
    scope: admission.accepted.scope, filename: 'result.md', mediaType: 'text/markdown' })
  return { active, bridge, admission, attachments, publish }
}

async function openCode(f: Awaited<ReturnType<typeof afPublicationFixture>>, attachments: MessageAttachmentRef[],
  failure?: { adopt: boolean; lostPublishAck: boolean }) {
  const active = await f.pause(attachments)
  const configuration = f.fixture.configurations.find((item) => item.agentId === f.context.agentId)!.harness
  if (configuration.harness !== 'opencode') throw new Error('Expected OpenCode fixture')
  const identity = { ownerAgentId: f.context.agentId, nativeSessionId: active.session.nativeSessionId,
    nativeTurnId: active.turn.nativeTurnId!, clientCorrelationId: active.correlation, directory: f.project, configuration }
  const admission = await resolveOpenCodeFileAdmission(f.database.pool, f.conversationId, identity)
  expect(admission?.attachments).toEqual(attachments)
  // Reuse ONLY the fake execution host. All service methods/receipts below are real.
  const host = createChatFileBackend()
  const statuses: Record<string, unknown> = { graphql: { status: 'disabled' } }
  const server = { expectedVersion: '1.18.31', generation: 1, async ensure() {}, async dispose() {},
    async request(path: string, init?: RequestInit) {
      const route = new URL(path, 'http://native.invalid').pathname
      let response: unknown = statuses
      if (route === '/config') response = { mcp: { graphql: { enabled: false } } }
      else if (route === '/mcp' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string }; statuses[body.name] = { status: 'connected' }
      } else if (route.endsWith('/disconnect')) response = true
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
    },
  }
  const service = f.service
  let token = ''
  const turn = new OpenCodeFileTurn({ host: host.host, server, endpoint: 'http://127.0.0.1:9876/mcp/files',
    appMcpServerName: 'graphql', maxFileBytes: MAX_FILE_BYTES, maxAttachments: 10,
    rememberCredential: (value) => { token = value },
    service: { sessions: {
      issueForAcceptedSession: (context, expiry) => service.sessions.issueForAcceptedSession(context, expiry, 'opencode'),
      authenticate: service.sessions.authenticate.bind(service.sessions), revoke: service.sessions.revoke.bind(service.sessions),
    }, artifacts: service.artifacts, list: service.list.bind(service), read: service.read.bind(service),
    createWorkingCopy: service.createWorkingCopy.bind(service),
    publish: async (...args: Parameters<typeof service.publish>) => {
      const result = await service.publish(...args)
      if (failure?.lostPublishAck) { failure.lostPublishAck = false; throw new Error('Injected lost publish acknowledgement') }
      return result
    },
    publishedForTurn: service.publishedForTurn.bind(service), writeWorkingCopy: service.writeWorkingCopy.bind(service),
    applyFormatEdit: service.applyFormatEdit.bind(service) },
    adoptPublished: async (context) => {
      if (failure?.adopt) throw new Error('Injected unavailable publication adoption')
      await adoptOpenCodePublications(f.database.pool, context)
    },
  })
  await turn.prepareInputs({ ...admission!, mode: 'write', executionHostId: host.host.executionHostId,
    directory: f.project, expiresAt: new Date(Date.now() + 60_000) },
  (input) => service.readAccepted(admission!.context, input), signal())
  turn.submissionAttempted(); await turn.acknowledge(signal())
  expect(token).toMatch(/^gql_file_/)
  f.native.onFinish = () => turn.finish('terminal', signal())
  const copy = await turn.createWorkingCopy(token, { commandId: randomUUID(), source: attachments[0]!,
    destination: admission!.context.scope }, signal())
  const publish = () => turn.publish(token, { commandId: randomUUID(), artifactId: copy.value.artifactId,
    scope: admission!.context.scope, filename: 'result.md', mediaType: 'text/markdown' }, signal())
  return { active, turn, admission: admission!, identity, host, token, publish }
}

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('AF-03 / AF-04 durable publication adoption', { timeout: 90_000 }, () => {
  for (const closure of ['terminal', 'process'] as const) {
    it(`OC-02: ${closure} cleanup retries exact ledger adoption after lost publication ACK`, async () => {
      const f = await afPublicationFixture('opencode')
      const attachments = [await f.upload()]
      const failure = { adopt: false, lostPublishAck: true }
      const t = await openCode(f, attachments, failure)
      await expect(t.publish()).rejects.toThrow('lost publish acknowledgement')
      const original = await f.publications(t.active.turn.messageId)
      expect(original).toHaveLength(1)
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
      failure.adopt = true
      await expect(closure === 'terminal' ? t.turn.finish('terminal', signal())
        : t.turn.nativeProcessClosed(signal())).rejects.toThrow('retry')
      expect(t.host.hostFiles.size).toBe(0)
      await expect(f.service.sessions.authenticate(t.token)).rejects.toThrow()
      failure.adopt = false
      await t.turn.retryCleanup(signal()); await t.turn.retryCleanup(signal())
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toEqual(original)
      expect(await f.readPins(t.active.turn.messageId)).toEqual([...attachments, ...original])
      expect(await f.publications(t.active.turn.messageId)).toEqual(original)
      expect((await f.database.pool.query(`select 1 from file_tool_sessions where revoked_at is null
        and record->'context'->>'messageId'=$1`, [t.active.turn.messageId])).rowCount).toBe(0)
      f.native.finish(); await f.settle()
    })
  }
  for (const failure of ['adopt_once', 'revoke_after_finalize'] as const) {
    it(`AF-03: Codex terminal close repairs ${failure} without another publication`, async () => {
      const f = await afPublicationFixture()
      const t = await codex(f, 1, failure)
      const publish = vi.spyOn(f.service, 'publish')
      // Production bound its method through a wrapper, so this spy observes the real service call.
      expect((await t.publish()).success).toBe(false)
      const original = await f.publications(t.active.turn.messageId)
      expect(original).toHaveLength(1)
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
      f.native.finish(); await f.settle()
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toEqual(original)
      expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
      await t.bridge.close(); await t.admission.adoptPublished(t.active.turn.nativeTurnId!, [])
      expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
      expect(await f.publications(t.active.turn.messageId)).toEqual(original)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(f.hosts.every((host) => host.closed)).toBe(true)
      expect((await f.database.pool.query(`select 1 from file_tool_sessions where revoked_at is null
        and record->'context'->>'messageId'=$1`, [t.active.turn.messageId])).rowCount).toBe(0)
      vi.restoreAllMocks()
      const next = await f.nextTurn()
      expect(await f.readPins(next.turn.messageId)).toHaveLength(1)
      expect(await f.readPins(next.turn.messageId)).not.toEqual(expect.arrayContaining(original))
    })
  }

  it('AF-03: a reconstructed transcript recovers the ledger even if the process never ran close', async () => {
    const f = await afPublicationFixture(), t = await codex(f, 1, 'lose_close')
    expect((await t.publish()).success).toBe(false)
    const original = await f.publications(t.active.turn.messageId)
    expect(original).toHaveLength(1)
    // Simulate a lost in-memory close callback; only PostgreSQL knows this pin.
    f.native.onFinish = undefined
    await f.database.pool.query(`update file_tool_sessions set revoked_at=clock_timestamp()
      where record->'context'->>'messageId'=$1`, [t.active.turn.messageId])
    f.native.finish(); await f.settle()
    expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
    expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
    expect(await f.readPins(t.active.turn.messageId)).toEqual([...t.attachments, ...original])
    expect(await f.publications(t.active.turn.messageId)).toEqual(original)
    await t.bridge.close() // Test-owned synthetic host still gets cleaned up.
    await f.nextTurn()
  })

  for (const selectedRun of [false, true]) {
    it(`AF-03: upload-free ${selectedRun ? 'selected-Run' : 'Agent'} inherited-reference cold recovery without adoption or close`, async () => {
      const f = await afPublicationFixture('codex', selectedRun), t = await codex(f, 0, 'lose_close')
      expect(t.admission.accepted.attachments).toEqual([])
      if (selectedRun) expect(t.admission.accepted.scope.chat).toMatchObject({
        runId: f.fixture.run.id, executionId: f.runExecution.id,
      })
      const publish = vi.spyOn(f.service, 'publish')
      const issue = vi.spyOn(f.service.sessions, 'issueForAcceptedSession')
      const upload = vi.spyOn(f.files, 'upload')
      const starts = f.native.starts
      expect((await t.publish()).success).toBe(false)
      const original = await f.publications(t.active.turn.messageId)
      expect(original).toHaveLength(1)
      f.native.onFinish = undefined
      await f.database.pool.query(`update file_tool_sessions set revoked_at=clock_timestamp()
        where record->'context'->>'messageId'=$1`, [t.active.turn.messageId])
      f.native.finish(); await f.settle()
      expect((await f.stored(t.active.turn.messageId)).attachmentRefs).toBeUndefined()
      expect((await f.stored(t.active.turn.messageId)).publicationRefs).toBeUndefined()
      // Every read constructs a new repository; recovery uses only finalized DB facts.
      expect(await f.readPins(t.active.turn.messageId)).toEqual(original)
      expect(await f.readPins(t.active.turn.messageId)).toEqual(original)
      const accepted = t.admission.accepted
      const bound = { ownerPrincipalId: accepted.ownerPrincipalId, scope: accepted.scope,
        nativeSessionId: accepted.nativeSessionId, turnId: t.active.turn.nativeTurnId!,
        messageId: t.active.turn.messageId, allowMutation: accepted.allowMutation, allowedTools: [...accepted.allowedTools] }
      const originalBinding = bindingIdentity(bound)
      const foreignBindings = [
        { ...bound, ownerPrincipalId: 'foreign-owner' }, { ...bound, nativeSessionId: 'foreign-thread' },
        { ...bound, turnId: 'foreign-turn' }, { ...bound, messageId: 'foreign-message' },
        { ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, conversationId: 'foreign-conversation' } } },
        ...(bound.scope.chat.kind === 'agent' ? [
          { ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, runId: 'foreign-run', executionId: 'foreign-execution' } } },
          ...(selectedRun ? [
            { ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, runId: 'foreign-run' } } },
            { ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, executionId: 'foreign-execution' } } },
          ] : []),
        ] : []),
      ]
      for (const foreign of foreignBindings) {
        await f.database.pool.query('update file_tool_publications set binding=$2 where file_id=$1',
          [original[0]!.fileId, bindingIdentity(foreign)])
        expect(await f.readPins(t.active.turn.messageId)).toEqual([])
      }
      await f.database.pool.query('update file_tool_publications set binding=$2 where file_id=$1',
        [original[0]!.fileId, originalBinding])
      await withAfMcp(f, async (_writer, reader) => {
        const denied = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId: 'foreign-workspace', query: f.context } })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
        const result = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.context } })
        const readback = AgentChatStateSchema.parse(result.structuredContent)
        expect(readback.messages.find((message) => message.id === t.active.turn.messageId)?.attachments?.map((file) => ({
          fileId: file.file.fileId, revisionId: file.revision.revisionId,
        }))).toEqual(original)
        expect(readback.messages.filter((message) => message.id !== t.active.turn.messageId)
          .flatMap((message) => message.attachments ?? [])).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ file: expect.objectContaining({ fileId: original[0]!.fileId }) }),
          ]))
      })
      expect(await f.publications(t.active.turn.messageId)).toEqual(original)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(issue).not.toHaveBeenCalled()
      // The original publish transfers bytes once; recovery never re-uploads.
      expect(upload).toHaveBeenCalledTimes(1)
      expect(f.native.starts).toBe(starts)
      await t.bridge.close()
    })
  }

  it('AF-03: a linked but unfinalized publication is not exposed by close or restart readback', async () => {
    const f = await afPublicationFixture(), t = await codex(f, 1)
    vi.spyOn(f.files, 'finalize').mockRejectedValueOnce(new Error('Injected failure before finalization'))
    expect((await t.publish()).success).toBe(false)
    expect((await f.database.pool.query(`select 1 from file_tool_publications
      where record->'context'->>'messageId'=$1`, [t.active.turn.messageId])).rowCount).toBe(1)
    expect(await f.publications(t.active.turn.messageId)).toEqual([])
    f.native.finish(); await f.settle()
    expect(await f.readPins(t.active.turn.messageId)).toEqual(t.attachments)
    expect((await f.stored(t.active.turn.messageId)).publicationRefs).toEqual([])
  })

  for (const count of [10, 1]) {
    it(`AF-04: Codex ${count} inputs plus twelve publications remain attachable and restart-safe`, async () => {
      const f = await afPublicationFixture(), t = await codex(f, count)
      const published: MessageAttachmentRef[] = []
      for (let index = 0; index < 12; index++) {
        published.push(asPin(toolValue(await t.publish())))
        const readback = await f.readPins(t.active.turn.messageId)
        expect(readback).toHaveLength(count + index + 1)
        expect(readback).toEqual(expect.arrayContaining([...t.attachments, ...published]))
      }
      f.native.finish(); await f.settle(); await t.bridge.close()
      expect((await f.stored(t.active.turn.messageId)).attachmentRefs).toEqual(t.attachments)
      const resumed = await f.resolver.resolve({ conversationId: f.conversationId, session: t.active.session,
        clientCorrelationId: t.active.correlation, signal: signal() })
      expect(resumed!.accepted.attachments).toEqual(t.attachments)
      await resumed!.dependencies.host.close()
      expect(await f.publications(t.active.turn.messageId)).toHaveLength(12)
      if (count === 10) await withAfMcp(f, async (_writer, reader) => {
          const result = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.context } })
        const readback = AgentChatStateSchema.parse(result.structuredContent).messages.find((message) => message.id === t.active.turn.messageId)!
        expect(readback.attachments).toHaveLength(22)
      })
      await f.nextTurn()
    })

    it(`AF-04: OpenCode ${count} inputs plus twelve publications survive terminal retries and the next turn`, async () => {
      const f = await afPublicationFixture('opencode'), attachments: MessageAttachmentRef[] = []
      for (let index = 0; index < count; index++) attachments.push(await f.upload())
      const t = await openCode(f, attachments), published: MessageAttachmentRef[] = []
      for (let index = 0; index < 12; index++) {
        const result = await t.publish()
        published.push({ fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId })
        expect(await f.readPins(t.active.turn.messageId)).toEqual([...attachments, ...published])
      }
      // Re-resolution while the turn is active still delivers only original inputs.
      expect((await resolveOpenCodeFileAdmission(f.database.pool, f.conversationId, t.identity))!.attachments).toEqual(attachments)
      f.native.finish(); await f.settle(); await t.turn.finish('terminal', signal())
      await adoptOpenCodePublications(f.database.pool, t.admission.context)
      expect((await f.stored(t.active.turn.messageId)).attachmentRefs).toEqual(attachments)
      expect(await f.readPins(t.active.turn.messageId)).toEqual([...attachments, ...published])
      expect(await f.publications(t.active.turn.messageId)).toHaveLength(12)
      expect(t.host.hostFiles.size).toBe(0)
      await expect(f.service.sessions.authenticate(t.token)).rejects.toThrow()
      const next = await openCode(f, [await f.upload()])
      expect(next.token).not.toBe(t.token)
      f.native.finish(); await f.settle()
      expect(next.host.hostFiles.size).toBe(0)
    })
  }
})
