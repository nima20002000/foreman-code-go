import type pg from 'pg'
import { SessionControlStateSchema, compactionBlocksSend, parseSessionCommand, type SessionMode } from '@graphql/contracts'
import { DomainError } from '../../errors.js'

/** Called under the existing conversation row lock, in the message transaction. */
export async function admitSessionMessage(client: Pick<pg.PoolClient, 'query'>, conversationId: string, mode?: SessionMode) {
  const result = await client.query<{ record: unknown }>(
    'select record from conversation_session_controls where conversation_id=$1 for update', [conversationId])
  if (!result.rows[0]) return
  const state = SessionControlStateSchema.parse(result.rows[0].record)
  if (compactionBlocksSend(state.compaction)) {
    throw new DomainError('SESSION_COMPACT_UNCONFIRMED', 'Recover compaction before sending another message.', 409)
  }
  if (!mode) return
  state.desiredMode = mode
  state.applicability = 'next-turn'
  state.revision++
  await client.query('update conversation_session_controls set record=$2::jsonb where conversation_id=$1',
    [conversationId, JSON.stringify(state)])
}

export function validateSessionMessage(content: string, mode?: SessionMode) {
  const command = parseSessionCommand(content)
  if (command.kind === 'invalid') throw new DomainError('SESSION_COMMAND_INVALID', command.message, 422)
  if (command.kind === 'compact' || command.kind === 'mode' || command.kind === 'new') {
    throw new DomainError('SESSION_COMMAND_ROUTE_REQUIRED', 'Use session controls for command-only operations; no message was sent.', 422)
  }
  if (command.kind === 'plan-task' && mode !== 'plan') {
    throw new DomainError('SESSION_PLAN_MODE_REQUIRED', 'Send this task with sessionMode: plan. No message was sent.', 422)
  }
}
