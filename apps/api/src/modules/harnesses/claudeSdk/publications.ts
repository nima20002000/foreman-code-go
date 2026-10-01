import type pg from 'pg'
import { MessageAttachmentRefSchema, type MessageAttachmentRef } from '@graphql/contracts/files'
import { bindingIdentity } from '../../files/tools/context.js'
import type { FileToolContext } from '../../files/tools/types.js'
import { mergeMessagePins } from '../../conversations/messagePublications.js'

/** Read-only recovery of finalized output after publish-before-adoption loss.
 * The exact native message receipt and sender come from admitted persisted facts;
 * uploads, current selection, callbacks, and native turn guesses are irrelevant. */
export async function readClaudeMessagePublications(query: Pick<pg.PoolClient, 'query'>,
  conversationId: string, messageIds: readonly string[]): Promise<Map<string, MessageAttachmentRef[]>> {
  const result = new Map<string, MessageAttachmentRef[]>()
  if (!messageIds.length) return result
  const turns = (await query.query<{
    message_id: string; owner_principal_id: string; native_session_id: string; native_message_id: string
    kind: 'agent' | 'operator'; operator_id: string | null
    workspace_id: string | null; workflow_id: string | null; agent_id: string | null
    origin_run_id: string | null; origin_execution_id: string | null
  }>(`select t.message_id,
      case when c.kind='operator' then c.owner_principal_id else t.payload->>'ownerPrincipalId' end as owner_principal_id,
      t.payload->'nativeSubmission'->>'nativeSessionId' as native_session_id,
      t.payload->'nativeSubmission'->>'nativeMessageId' as native_message_id,
      c.kind,c.operator_id,c.workspace_id,c.workflow_id,c.agent_id,c.origin_run_id,c.origin_execution_id
    from operator_conversations c join operator_conversation_turns t on t.conversation_id=c.id
    join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id
      and m.client_request_id=t.request_id and m.role='user'
    where c.id=$1 and c.harness='claude' and c.deleted_at is null
      and c.kind in ('agent','operator') and t.intent<>'steer' and t.message_id=any($2::text[])
      and t.payload->'nativeSubmission'->>'kind'='message'
      and length(t.payload->'nativeSubmission'->>'nativeSessionId')>0
      and length(t.payload->'nativeSubmission'->>'nativeMessageId')>0
      and length(t.payload->'nativeSubmission'->>'clientCorrelationId')>0
      and ((c.kind='agent' and t.payload->>'ownerPrincipalId' is not null
          and c.workspace_id is not null and c.workflow_id is not null and c.agent_id is not null)
        or (c.kind='operator' and c.owner_principal_id is not null and c.operator_id is not null
          and c.workspace_id is null and c.workflow_id is null and c.agent_id is null
          and c.origin_run_id is null and c.origin_execution_id is null))`, [conversationId, messageIds])).rows
  const bindings = new Map<string, typeof turns[number]>()
  for (const turn of turns) {
    const context: FileToolContext = { ownerPrincipalId: turn.owner_principal_id,
      nativeSessionId: turn.native_session_id, nativeMessageId: turn.native_message_id,
      messageId: turn.message_id, allowMutation: false, allowedTools: [],
      scope: { kind: 'temporary', chat: turn.kind === 'operator'
        ? { kind: 'operator', conversationId, ownerPrincipalId: turn.owner_principal_id, operatorId: turn.operator_id! }
        : { kind: 'agent', conversationId, agentId: turn.agent_id!, workspaceId: turn.workspace_id!, workflowId: turn.workflow_id!,
          ...(turn.origin_run_id !== null && turn.origin_execution_id !== null
            ? { runId: turn.origin_run_id, executionId: turn.origin_execution_id } : {}) } },
    }
    bindings.set(bindingIdentity(context), turn)
  }
  if (!bindings.size) return result
  const published = (await query.query<{ binding: string; owner_principal_id: string; file_id: string; revision_id: string }>(`
    select p.binding,p.owner_principal_id,p.file_id,p.revision_id from file_tool_publications p
    join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      and a.file_id=p.file_id and a.revision_id=p.revision_id and a.state='finalized'
    where p.binding=any($1::text[]) order by p.request_id`, [[...bindings.keys()]])).rows
  for (const publication of published) {
    const turn = bindings.get(publication.binding)
    if (!turn || turn.owner_principal_id !== publication.owner_principal_id) continue
    const ref = MessageAttachmentRefSchema.parse({ fileId: publication.file_id, revisionId: publication.revision_id })
    result.set(turn.message_id, mergeMessagePins(result.get(turn.message_id) ?? [], [ref]))
  }
  return result
}
