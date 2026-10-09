import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { CodexFileCallResult } from '../src/modules/harnesses/codexFiles/port.js'
import { afPublicationFixture } from './helpers/afPublicationFixture.js'
import { withAfMcp } from './helpers/afMcp.js'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'

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

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('AF-03 / AF-04 durable publication adoption', { timeout: 90_000 }, () => {
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
      const f = await afPublicationFixture({ selectedRun }), t = await codex(f, 0, 'lose_close')
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
      // Published facts are immutable even to a later application writer.
      await expect(f.database.pool.query('update file_tool_publications set binding=$2 where file_id=$1',
        [original[0]!.fileId, '0'.repeat(64)])).rejects.toThrow('append-only')
      expect(await f.readPins(t.active.turn.messageId)).toEqual(original)
      await withAfMcp(f, async (_writer, reader) => {
        const denied = await reader.callTool({ name: 'agent_chat_read', arguments: { workspaceId: 'foreign-workspace', query: f.context } })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
        const result = await reader.callTool({ name: 'agent_chat_read', arguments: f.selection
          ? { workspaceId: f.workspaceId, selection: { workflowId: f.selection.workflowId, runId: f.selection.runId,
            workflowNodeId: f.selection.workflowNodeId, executionId: f.selection.executionId } }
          : { workspaceId: f.workspaceId, query: f.context } })
        let readback
        if (f.selection) {
          const selected = ReadSelectedRunChatResponseSchema.parse(decodeMcpToolResult(result))
          if (selected.kind !== 'selected') throw new Error('Expected the exact selected Run chat')
          expect(selected.selection).toEqual(f.selection)
          readback = selected.state
        } else readback = AgentChatStateSchema.parse(decodeMcpToolResult(result))
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

    it(`AF-03: cold ${selectedRun ? 'selected-Run' : 'Agent'} readback excludes every foreign immutable publication binding`, async () => {
      const f = await afPublicationFixture({ selectedRun })
      const foreignContexts: Array<(bound: FileToolContext) => FileToolContext> = [
        bound => ({ ...bound, ownerPrincipalId: 'foreign-owner' }),
        bound => ({ ...bound, nativeSessionId: 'foreign-thread' }),
        bound => ({ ...bound, turnId: 'foreign-turn' }),
        bound => ({ ...bound, messageId: 'foreign-message' }),
        bound => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, conversationId: 'foreign-conversation' } } }),
        bound => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, runId: 'foreign-run', executionId: 'foreign-execution' } } }),
        ...(selectedRun ? [
          (bound: FileToolContext) => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, runId: 'foreign-run' } } }),
          (bound: FileToolContext) => ({ ...bound, scope: { ...bound.scope, chat: { ...bound.scope.chat, executionId: 'foreign-execution' } } }),
        ] : []),
      ]
      for (const foreign of foreignContexts) {
        const t = await codex(f, 0, 'lose_close')
        const append = PostgresFileToolRepository.prototype.linkPublication
        // Inject stale/foreign receipt identity BEFORE the real append-only insert;
        // authentication, allocation, finalization and readback remain production.
        const insertion = vi.spyOn(PostgresFileToolRepository.prototype, 'linkPublication')
          .mockImplementationOnce(function (this: PostgresFileToolRepository, link) {
            return append.call(this, { ...link, binding: bindingIdentity(foreign(link.context)) })
          })
        try { expect((await t.publish()).success).toBe(false) } finally { insertion.mockRestore() }
        const receipts = await f.publications(t.active.turn.messageId)
        expect(receipts).toHaveLength(1)
        f.native.onFinish = undefined
        f.native.finish(); await f.settle()
        const starts = f.native.starts
        expect(await f.readPins(t.active.turn.messageId)).toEqual([])
        expect(await f.readPins(t.active.turn.messageId)).toEqual([])
        expect(await f.publications(t.active.turn.messageId)).toEqual(receipts)
        expect(f.native.starts).toBe(starts)
        await t.bridge.close()
      }
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
        const readback = AgentChatStateSchema.parse(decodeMcpToolResult(result)).messages.find((message) => message.id === t.active.turn.messageId)!
        expect(readback.attachments).toHaveLength(22)
      })
      await f.nextTurn()
    })

  }
})
