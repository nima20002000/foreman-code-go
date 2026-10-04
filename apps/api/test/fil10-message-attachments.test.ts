import { createHash } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { MessageSchema, SendOperatorMessageRequestSchema, type SendOperatorMessageRequest } from '@foreman-code/contracts'
import { SendAgentChatMessageRequestSchema, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { messageAttachmentIdentity, type MessageAttachmentRef } from '@foreman-code/contracts/files'

import { agentChatInputHash } from '../src/modules/conversations/agentChatRepository.js'
import { commandHash, commandPayload } from '../src/modules/conversations/operatorChatRepository.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { hydrateMessageAttachments, validateMessageAttachments, withMessageAttachmentRefs } from '../src/modules/conversations/messageAttachments.js'

const first = { fileId: 'file-1', revisionId: 'revision-1' }
const second = { fileId: 'file-2', revisionId: 'revision-2' }
const context = { workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
const agentInput: SendAgentChatMessageRequest = { requestId: 'send', content: 'hello', intent: 'next_turn', context, expectedConversationId: 'chat' }
const operatorInput: SendOperatorMessageRequest = { requestId: 'send', content: 'hello' }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function row(ref = first) {
  return { file_id: ref.fileId, revision_id: ref.revisionId, current_revision_id: 'newer-revision',
    chat_kind: 'operator', owner_principal_id: 'owner', operator_id: 'operator', conversation_id: 'chat',
    agent_id: null, workspace_id: null, workflow_id: null, run_id: null, execution_id: null,
    state: 'ready', created_at: new Date('2026-09-20T00:00:00.000Z'), retention_duration_seconds: 604800,
    expires_at: new Date('2026-09-27T00:00:00.000Z'), filename: 'same.md', media_type: 'text/markdown',
    byte_size: '5', sha256: 'a'.repeat(64), origin: 'upload', revision_created_at: new Date('2026-09-20T00:00:00.000Z'),
    read_at: new Date('2026-09-26T00:00:00.000Z') }
}
function queryable(rows = [row()]) {
  // Operator pins are now publication-recovery candidates; this fake has no Codex turns.
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('operator_conversation_turns') ? []
    : sql.includes('for share of f') ? rows.map((entry) => ({ file_id: entry.file_id })) : rows }))
  return { query, db: { query } as unknown as Pick<pg.PoolClient, 'query'> }
}
function message(id = 'message', refs?: MessageAttachmentRef[]) {
  return withMessageAttachmentRefs(MessageSchema.parse({ id, conversationId: 'chat', role: 'user', content: 'hello' }), refs)
}

describe('FIL-10 attachment contracts and receipt compatibility', () => {
  it('composes the frozen attachment fields into both real send contracts', () => {
    expect(SendOperatorMessageRequestSchema.parse(operatorInput).attachments).toEqual([])
    expect(SendAgentChatMessageRequestSchema.parse(agentInput).attachments).toEqual([])
    for (const [schema, input] of [[SendOperatorMessageRequestSchema, operatorInput], [SendAgentChatMessageRequestSchema, agentInput]] as const) {
      expect(schema.parse({ ...input, attachments: [first, second] }).attachments).toEqual([first, second])
      expect(schema.safeParse({ ...input, attachments: [{ ...first, workspaceId: 'forged' }] }).success).toBe(false)
      expect(schema.safeParse({ ...input, attachments: [first, { ...first, revisionId: 'another' }] }).success).toBe(false)
      expect(schema.safeParse({ ...input, attachments: Array.from({ length: 11 }, (_, n) => ({ fileId: `f${n}`, revisionId: `r${n}` })) }).success).toBe(false)
    }
  })
  it('preserves every old Operator identity field, including the original property order', () => {
    const inputs: SendOperatorMessageRequest[] = [operatorInput, { ...operatorInput, context: {} },
      { ...operatorInput, context: { runId: 'run', route: '/board', workspaceId: 'workspace', workflowId: 'workflow' },
        configurationVersionId: 'config', defaultsRevision: 7, forkExpectedRevision: 9,
        settings: { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', serviceTier: 'standard', showThinking: false } }]
    for (const input of inputs) {
      const legacy = { content: input.content, ...(input.settings ? { settings: input.settings } : {}),
        ...(input.configurationVersionId === undefined ? {} : { configurationVersionId: input.configurationVersionId }),
        ...(input.defaultsRevision === undefined ? {} : { defaultsRevision: input.defaultsRevision }),
        ...(input.forkExpectedRevision === undefined ? {} : { forkExpectedRevision: input.forkExpectedRevision }),
        ...(input.context && Object.keys(input.context).length ? { context: Object.fromEntries(Object.entries(input.context)
          .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) } : {}) }
      expect(commandPayload(input)).toEqual(legacy)
      expect(commandHash(input)).toBe(digest(legacy))
      expect(commandHash({ ...input, attachments: [], recovery: 'receipt' })).toBe(digest(legacy))
    }
  })
  it('preserves Agent text/intent/context/target hashes byte for byte', () => {
    for (const intent of ['next_turn', 'steer', 'interrupt_and_send'] as const) {
      for (const target of [undefined, 'active-turn']) {
        const input = { ...agentInput, intent, expectedNativeTurnId: target }
        const legacy = digest([input.content, input.intent, input.context, ...(target === undefined ? [] : [target])])
        expect(agentChatInputHash(input)).toBe(legacy)
        expect(agentChatInputHash({ ...input, attachments: [] })).toBe(legacy)
      }
    }
  })
  it('adds ordered immutable pins, rather than replacing the existing receipt identity', () => {
    const variants = [[first], [second], [{ ...first, revisionId: 'replacement' }], [first, second], [second, first]]
    expect(new Set(variants.map((attachments) => commandHash({ ...operatorInput, attachments }))).size).toBe(variants.length)
    expect(new Set(variants.map((attachments) => agentChatInputHash({ ...agentInput, attachments }))).size).toBe(variants.length)
    expect(commandPayload({ ...operatorInput, attachments: [first] }).attachmentIdentity)
      .toBe(messageAttachmentIdentity({ requestId: 'send', attachments: [first] }))
    const attached = { ...agentInput, attachments: [first] }
    for (const changed of [{ ...attached, content: 'changed' }, { ...attached, intent: 'steer' as const },
      { ...attached, context: { ...context, runId: 'different' } }, { ...attached, expectedNativeTurnId: 'different' }]) {
      expect(agentChatInputHash(changed)).not.toBe(agentChatInputHash(attached))
    }
    expect(commandHash({ ...operatorInput, attachments: [first], content: 'changed' }))
      .not.toBe(commandHash({ ...operatorInput, attachments: [first] }))
  })
})

describe('FIL-10 message metadata and lifecycle adapter', () => {
  it('keeps text-only readback unchanged without looking up file metadata', async () => {
    const { db, query } = queryable()
    const legacy = { id: 'message', conversationId: 'chat', role: 'user', content: 'hello' }
    expect(message()).toEqual(legacy)
    await validateMessageAttachments(db, 'chat', [])
    expect(await hydrateMessageAttachments(db, 'chat', [legacy])).toEqual([{ ...legacy, originalInput: null }])
    // Unreceipted text reads exact original admission without depending on file publication relations.
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls.some(([sql]) => sql.includes('jsonb_to_recordset'))).toBe(false)
    expect(query.mock.calls.every(([sql]) => sql.includes('operator_conversation_turns'))).toBe(true)
  })
  it('discovers upload-free receipt messages for finalized Codex ledger recovery', async () => {
    const stored = { ...message(), requestId: 'send' }
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('select m.id,t.request_id')
      ? [{ id: stored.id, request_id: stored.requestId, content: stored.content, input_pins: [] }]
      : sql.includes('operator_conversation_turns') ? [{
      message_id: stored.id, native_turn_id: 'turn', owner_principal_id: 'owner', native_session_id: 'thread',
      kind: 'agent', operator_id: null, workspace_id: 'workspace', workflow_id: 'workflow', agent_id: 'agent',
      origin_run_id: null, origin_execution_id: null,
    }] : sql.includes('file_tool_publications') ? [{
      binding: bindingIdentity({ ownerPrincipalId: 'owner', nativeSessionId: 'thread', turnId: 'turn', messageId: stored.id,
        allowMutation: false, allowedTools: [], scope: { kind: 'temporary', chat: {
          kind: 'agent', agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow', conversationId: 'chat',
        } } }), owner_principal_id: 'owner', file_id: first.fileId, revision_id: first.revisionId,
    }] : [{ ...row(), chat_kind: 'agent', operator_id: null, agent_id: 'agent', workspace_id: 'workspace', workflow_id: 'workflow' }] }))
    const loaded = await hydrateMessageAttachments({ query } as unknown as Pick<pg.PoolClient, 'query'>, 'chat', [stored])
    expect(loaded[0]!.attachments![0]!.revision).toMatchObject(first)
    expect(loaded[0]!.originalInput).toEqual({ requestId: stored.requestId, content: stored.content, attachments: [] })
    expect(query.mock.calls[0]![0]).toContain('operator_conversation_turns')
    expect(query).toHaveBeenCalledTimes(4)
  })
  it('does not query file relations for a receipt without an eligible persisted Codex turn', async () => {
    const { db, query } = queryable()
    const stored = { ...message(), requestId: 'send' }
    expect(await hydrateMessageAttachments(db, 'chat', [stored])).toEqual([{ ...stored, originalInput: null }])
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0]).toContain("to_regclass('file_tool_publications')")
    expect(query.mock.calls.every(([sql]) => !sql.includes('from file_tool_publications'))).toBe(true)
  })
  it('stores pins only, then returns metadata for the pinned revision, never the newer head', async () => {
    const { db, query } = queryable()
    const stored = message('message', [first])
    expect(stored).toHaveProperty('attachmentRefs', [first])
    expect(stored).not.toHaveProperty('attachments')
    const result = await hydrateMessageAttachments(db, 'chat', [stored])
    expect(result[0]).not.toHaveProperty('attachmentRefs')
    expect(result[0]!.attachments![0]).toMatchObject({
      file: { state: 'ready', expiresAt: '2026-09-27T00:00:00.000Z', currentRevisionId: 'newer-revision' },
      revision: { ...first, filename: 'same.md', mediaType: 'text/markdown', byteSize: 5 },
    })
    // One lookup each for pins, exact original admission, and publication recovery.
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[0]![0]).not.toContain('storage_key')
  })
  it('deduplicates page lookups by both IDs while retaining message order and historical revisions', async () => {
    const historical = { ...first, revisionId: 'older' }
    const { db, query } = queryable([row(first), row(historical)])
    const loaded = await hydrateMessageAttachments(db, 'chat', [message('a', [first]), message('b', [historical]), message('c', [first])])
    expect(loaded.map((entry) => entry.attachments![0]!.revision.revisionId)).toEqual(['revision-1', 'older', 'revision-1'])
    expect(query).toHaveBeenCalledTimes(3)
  })
  for (const state of ['pending', 'expired', 'removed'] as const) {
    it(`rejects ${state} at admission, but retains its metadata on old messages`, async () => {
      const { db } = queryable([{ ...row(), state }])
      await expect(validateMessageAttachments(db, 'chat', [first])).rejects.toMatchObject({
        code: state === 'pending' ? 'MESSAGE_ATTACHMENT_NOT_READY' : 'MESSAGE_ATTACHMENT_UNAVAILABLE',
      })
      expect((await hydrateMessageAttachments(db, 'chat', [message('message', [first])]))[0]!.attachments![0]!.file.state).toBe(state)
    })
  }
  it('uses the post-lock database clock at the exact expiry boundary without a sweeper', async () => {
    const expired = row(); expired.read_at = expired.expires_at
    const { db, query } = queryable([expired])
    await expect(validateMessageAttachments(db, 'chat', [first])).rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_UNAVAILABLE' })
    expect(query.mock.calls[0]![0]).toContain('order by f.file_id for share of f')
    expect(query.mock.calls[1]![0]).toContain('clock_timestamp()')
    expect((await hydrateMessageAttachments(db, 'chat', [message('message', [first])]))[0]!.attachments![0]!.file.state).toBe('expired')
  })
  it('rejects missing/foreign pins without synthesizing a metadata DTO', async () => {
    const { db } = queryable([])
    await expect(validateMessageAttachments(db, 'chat', [first])).rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_NOT_FOUND' })
    await expect(hydrateMessageAttachments(db, 'chat', [message('message', [first])]))
      .rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_METADATA_UNAVAILABLE' })
  })
  it('does not accept an unpinned revision just because the logical file exists', async () => {
    const { db } = queryable()
    await expect(validateMessageAttachments(db, 'chat', [{ ...first, revisionId: 'missing' }]))
      .rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_NOT_FOUND' })
  })
  it('refuses a cross-conversation message envelope before a metadata lookup', async () => {
    const { db, query } = queryable()
    await expect(hydrateMessageAttachments(db, 'other-chat', [message('message', [first])]))
      .rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_CONTEXT_MISMATCH' })
    expect(query).not.toHaveBeenCalled()
  })
})
