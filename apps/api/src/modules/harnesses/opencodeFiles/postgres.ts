import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { AgentConfigurationVersionSchema, MessageSchema, OpenCodeHarnessConfigurationSchema } from '@foreman-code/contracts'
import { MessageAttachmentRefsSchema, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { agentChatCorrelation } from '../../conversations/agentChatRepository.js'
import { DomainError } from '../../errors.js'
import { MessagePublicationRefsSchema, mergeMessagePins } from '../../conversations/messagePublications.js'
import { bindingIdentity } from '../../files/tools/context.js'
import type { FileToolContext } from '../../files/tools/types.js'
import { nativeMessageId } from '../opencodeProtocol.js'
import type { OpenCodeChatFileIdentity } from './chat.js'

interface AdmissionRow {
  workspace_id: string; workflow_id: string; agent_id: string; origin_run_id: string | null
  origin_execution_id: string | null; agent_configuration_version_id: string
  native_session_id: string; working_directory: string; request_id: string; message_id: string
  native_turn_id: string | null; message_record: unknown; configuration_record: unknown
  owner_principal_id: string | null
}

/** Read only the accepted receipt and its immutable user message. No current Board selection is consulted. */
export async function resolveOpenCodeFileAdmission(pool: pg.Pool, conversationId: string,
  identity: OpenCodeChatFileIdentity): Promise<{ context: FileToolContext; attachments: MessageAttachmentRef[] } | undefined> {
  const prefix = `agent-chat:${conversationId}:`
  if (!identity.clientCorrelationId.startsWith(prefix)) throw new DomainError('FILE_CONTEXT_DENIED', 'The chat correlation is foreign.', 403)
  const requestId = identity.clientCorrelationId.slice(prefix.length)
  if (!requestId || nativeMessageId(identity.clientCorrelationId) !== identity.nativeTurnId) {
    throw new DomainError('FILE_CONTEXT_DENIED', 'The native turn is not the accepted chat command.', 403)
  }
  const row = (await pool.query<AdmissionRow>(`select c.workspace_id,c.workflow_id,c.agent_id,c.origin_run_id,c.origin_execution_id,
      c.agent_configuration_version_id,c.native_session_id,c.record->>'workingDirectory' as working_directory,
      t.request_id,t.message_id,t.native_turn_id,t.payload->>'ownerPrincipalId' as owner_principal_id,
      m.record as message_record,v.record as configuration_record
    from operator_conversations c
    join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=$2
    join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id
      and m.role='user' and m.client_request_id=t.request_id
    join agent_configuration_versions v on v.id=c.agent_configuration_version_id
      and v.workspace_id=c.workspace_id and v.agent_id=c.agent_id
    where c.id=$1 and c.kind='agent' and c.harness='opencode' and c.deleted_at is null
      and t.delivery in ('submitting','accepted','unknown')`, [conversationId, requestId])).rows[0]
  if (!row) throw new DomainError('FILE_ADMISSION_NOT_FOUND', 'The accepted chat command was not found.', 409)
  const message = MessageSchema.omit({ attachments: true }).extend({
    attachmentRefs: MessageAttachmentRefsSchema.optional(), publicationRefs: MessagePublicationRefsSchema.optional(),
  }).parse(row.message_record)
  const attachments = message.attachmentRefs ?? []
  // Inherited references use the same scoped tools even without temporary inputs.
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration_record)
  const acceptedHarness = OpenCodeHarnessConfigurationSchema.parse(configuration.harness)
  if (message.id !== row.message_id || message.requestId !== requestId || message.conversationId !== conversationId
    || row.agent_id !== identity.ownerAgentId || row.native_session_id !== identity.nativeSessionId
    || row.working_directory !== identity.directory || !isDeepStrictEqual(acceptedHarness, identity.configuration)
    || row.native_turn_id && row.native_turn_id !== identity.nativeTurnId) {
    throw new DomainError('FILE_ADMISSION_MISMATCH', 'The accepted chat identity or security configuration changed.', 409)
  }
  // Shared Agent attachments belong to the conversation, not necessarily to the
  // sender. Only the authenticated sender frozen in the receipt grants authority.
  if (!row.owner_principal_id) throw new DomainError(
    'FILE_ADMISSION_OWNER_MISSING', 'The persisted file turn has no authenticated sender.', 409)
  const pins = (await pool.query<{ pin_count: string }>(`select count(*)::text as pin_count
    from jsonb_to_recordset($2::jsonb) as pin("fileId" text,"revisionId" text)
    join files f on f.file_id=pin."fileId" and f.conversation_id=$1 and f.chat_kind='agent'
      and f.agent_id=$3 and f.workspace_id=$4 and f.workflow_id=$5
      and f.run_id is not distinct from $6 and f.execution_id is not distinct from $7
    join file_revisions r on r.file_id=f.file_id and r.revision_id=pin."revisionId"`,
  [conversationId, JSON.stringify(attachments), row.agent_id, row.workspace_id, row.workflow_id,
    row.origin_run_id, row.origin_execution_id])).rows[0]
  if (Number(pins?.pin_count) !== attachments.length) {
    throw new DomainError('FILE_ATTACHMENT_OWNER_MISMATCH', 'Attachments require exact pins in the accepted conversation scope.', 409)
  }
  const allowMutation = acceptedHarness.nativeAgent !== 'plan'
  const scope: FileToolContext['scope'] = { kind: 'temporary', chat: { kind: 'agent', conversationId,
    agentId: row.agent_id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
    ...(row.origin_run_id && row.origin_execution_id ? { runId: row.origin_run_id, executionId: row.origin_execution_id } : {}) } }
  return { context: { ownerPrincipalId: row.owner_principal_id, scope,
    nativeSessionId: identity.nativeSessionId, turnId: identity.nativeTurnId, messageId: row.message_id,
    allowMutation, allowedTools: ['files.list', 'files.read',
      ...(allowMutation ? ['files.create_working_copy', 'files.write_working_copy', 'files.apply_format_edit', 'files.publish_result'] as const : [])] },
  attachments }
}

/** Adoption uses only the durable publication ledger and its original message. It needs no live token. */
export async function adoptOpenCodePublications(pool: pg.Pool, context: FileToolContext): Promise<void> {
  const chat = context.scope.chat
  if (chat.kind !== 'agent' || !context.messageId) throw new DomainError('FILE_CONTEXT_DENIED', 'A chat message binding is required.', 403)
  const client = await pool.connect()
  try {
    await client.query('begin')
    const publishedTurn = await client.query(`select 1 from file_tool_publications p
      join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      where p.binding=$1 and a.state='finalized' limit 1`, [bindingIdentity(context)])
    // Preparation cannot publish; its resources can be reclaimed before a native acknowledgement exists.
    if (!publishedTurn.rowCount) {
      await client.query('commit')
      return
    }
    const row = (await client.query<{ request_id: string; message_record: unknown }>(`select t.request_id,m.record as message_record
      from operator_conversations c
      join operator_conversation_turns t on t.conversation_id=c.id and t.message_id=$2
      join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id
      where c.id=$1 and c.kind='agent' and c.deleted_at is null and c.native_session_id=$3
        and t.native_turn_id=$4 and c.agent_id=$5 and c.workspace_id=$6 and c.workflow_id=$7
        and c.origin_run_id is not distinct from $8 and c.origin_execution_id is not distinct from $9
        and t.payload->>'ownerPrincipalId'=$10
      for update of m`, [chat.conversationId, context.messageId, context.nativeSessionId,
      context.turnId, chat.agentId, chat.workspaceId, chat.workflowId, chat.runId ?? null, chat.executionId ?? null,
      context.ownerPrincipalId])).rows[0]
    if (!row) throw new DomainError('FILE_ADOPTION_MISMATCH', 'The originating native chat message is unavailable.', 409)
    if (nativeMessageId(agentChatCorrelation(chat.conversationId, row.request_id)) !== context.turnId) {
      throw new DomainError('FILE_ADOPTION_MISMATCH', 'The native turn does not match its receipt.', 409)
    }
    const message = MessageSchema.omit({ attachments: true }).extend({
      attachmentRefs: MessageAttachmentRefsSchema.optional(), publicationRefs: MessagePublicationRefsSchema.optional(),
    }).parse(row.message_record)
    if (message.id !== context.messageId || message.requestId !== row.request_id) {
      throw new DomainError('FILE_ADOPTION_MISMATCH', 'The originating message changed.', 409)
    }
    const originals = message.attachmentRefs ?? []
    const pins = (await client.query<{ count: string }>(`select count(*)::text as count
      from jsonb_to_recordset($1::jsonb) as pin("fileId" text,"revisionId" text)
      join files f on f.file_id=pin."fileId" and f.conversation_id=$2
        and f.chat_kind='agent' and f.agent_id=$3 and f.workspace_id=$4 and f.workflow_id=$5
        and f.run_id is not distinct from $6 and f.execution_id is not distinct from $7
      join file_revisions r on r.file_id=f.file_id and r.revision_id=pin."revisionId"`,
    [JSON.stringify(originals), chat.conversationId, chat.agentId,
      chat.workspaceId, chat.workflowId, chat.runId ?? null, chat.executionId ?? null])).rows[0]
    if (Number(pins?.count) !== originals.length) {
      throw new DomainError('FILE_ADOPTION_MISMATCH', 'The originating attachments have another scope or revision.', 409)
    }
    const published = (await client.query<{ file_id: string; revision_id: string }>(`select p.file_id,p.revision_id
      from file_tool_publications p join file_allocations a
        on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id and a.state='finalized'
      join files f on f.file_id=p.file_id and f.owner_principal_id=p.owner_principal_id
        and f.conversation_id=$2 and f.chat_kind='agent' and f.agent_id=$3
        and f.workspace_id=$4 and f.workflow_id=$5
        and f.run_id is not distinct from $6 and f.execution_id is not distinct from $7
      where p.binding=$1 and p.owner_principal_id=$8 order by p.request_id`,
    [bindingIdentity(context), chat.conversationId, chat.agentId, chat.workspaceId, chat.workflowId,
      chat.runId ?? null, chat.executionId ?? null, context.ownerPrincipalId])).rows
    const refs = mergeMessagePins(originals, message.publicationRefs ?? [],
      published.map((item) => ({ fileId: item.file_id, revisionId: item.revision_id })))
      .filter((ref) => !originals.some((input) => input.fileId === ref.fileId))
    if (refs.length !== (message.publicationRefs ?? []).length) {
      await client.query('update operator_conversation_messages set record=$2::jsonb where id=$1',
        [context.messageId, JSON.stringify({ ...message, publicationRefs: refs })])
    }
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally { client.release() }
}
