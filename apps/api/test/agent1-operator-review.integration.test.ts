import { randomUUID } from 'node:crypto'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, DEFAULT_HARNESS_DEFAULTS, NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { acceptRunAuthority, bindRunAuthority } from '../src/modules/access/runAuthority.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { eventually, operator, ReviewManager } from './fixtures/agent1OperatorChat.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2603'
let schema: string, admin: pg.Pool, pool: pg.Pool, access: PostgresAccessService
let owner: ManagementPrincipal, stranger: ManagementPrincipal, runAuthority: ManagementPrincipal, humanToken: string
let repository: PostgresOperatorConversationRepository, chat: OperatorChatService
let managers: Map<string, ReviewManager>
const conversationId = 'operator-review:interaction-one'

async function interaction(id: string) {
  await pool.query(`insert into durable_interactions
    (id,workspace_id,workflow_id,run_id,execution_id,requesting_agent_id,harness,native_session_id,native_request_id,status,record)
    values($1,'workspace-one','workflow-one','run-one','execution-one','worker-one','codex','worker-native-session',$1,'pending',$2::jsonb)`,
  [id, JSON.stringify({ id, runId: 'run-one', status: 'pending', graphThreadId: 'run-one', graphInterruptId: 'interrupt-one', approval: { handler: 'operator' } })])
}
async function reviewToken(id: string) {
  const issued = await access.issue({ name: 'test review credential', audience: 'operator',
    grants: [{ scope: {}, actions: ['agents:read'] }], expiresAt: new Date(owner.expiresAt) })
  await pool.query('update management_principals set delegated_from=$2 where id=$1', [issued.principal.id, runAuthority.id])
  await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [issued.principal.id, id])
  return issued
}
async function startReview() {
  await chat.reviewInteraction('interaction-one', runAuthority)
  await eventually(async () => Boolean((await repository.get(conversationId))?.pendingInteraction))
  return managers.get(conversationId)!
}

beforeEach(async () => {
  schema = `agent1_review_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  access = new PostgresAccessService(pool)
  const issued = await access.issue({ name: 'Run owner', audience: 'operator', grants: operator().grants, expiresAt: new Date(Date.now() + 600_000) })
  owner = issued.principal; humanToken = issued.token
  stranger = (await access.issue({ name: 'Unrelated valid Operator', audience: 'operator', grants: operator().grants, expiresAt: new Date(owner.expiresAt) })).principal
  await pool.query(`insert into workspaces(id,record) values('workspace-one','{}');
    insert into workflows(id,workspace_id,record) values('workflow-one','workspace-one','{}');
    insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record)
      values('workflow-version-one','workspace-one','workflow-one',1,'node-one','{}')`)
  const client = await pool.connect()
  try {
    await client.query('begin')
    const accepted = await acceptRunAuthority(client, owner, true)
    runAuthority = accepted.principal
    await client.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values('run-one','workspace-one','workflow-one','workflow-version-one','waiting',$1::jsonb)`,
    [JSON.stringify({ id: 'run-one', authorizationPrincipalId: runAuthority.id, executionState: 'waiting' })])
    await bindRunAuthority(client, 'run-one', accepted)
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  await interaction('interaction-one')
  repository = new PostgresOperatorConversationRepository(pool)
  managers = new Map()
  chat = new OperatorChatService(repository, new PostgresOperatorRepository(pool), (_configuration, id) => {
    let manager = managers.get(id)
    if (!manager) {
      manager = new ReviewManager()
      manager.session.nativeSessionId = `native:${id}`
      manager.pendingInteraction = { session: manager.session, turn: { nativeTurnId: 'review-turn-1', nativeRequestId: `permission:${id}` },
        nativeRequestType: 'item/commandExecution/requestApproval', request: { command: ['pnpm', 'test'] },
        responseOptions: NATIVE_INTERACTION_FIXTURES.codex.responseOptions }
      managers.set(id, manager)
    }
    return manager
  }, '/tmp/graphql-agent1-tests', {
    current: (id) => access.currentOperator(id), assertConfiguration() {},
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
    release: async (id) => { await pool.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
      where id in (select principal_id from operator_chat_credentials where conversation_id=$1)`, [id]) },
  })
}, 30_000)

afterEach(async () => {
  await chat?.shutdown()
  await pool?.end()
  if (schema) await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
})

describe('F4/F5: automatic Operator review ownership and lifetime (real PostgreSQL)', () => {
  it('lets only the recorded human Run owner discover, inspect, respond and cancel an automatic review', async () => {
    const manager = await startReview()
    expect((await chat.list(owner)).map((item) => item.id)).toContain(conversationId)
    expect((await chat.summaries(owner)).map((item) => item.conversationId)).toContain(conversationId)
    expect(await chat.list(stranger)).toEqual([])
    expect(await chat.summaries(stranger)).toEqual([])
    await expect(chat.get(conversationId, stranger)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    const before = await chat.get(conversationId, owner)
    expect((await repository.active(conversationId))?.owner_principal_id).toBe(runAuthority.id)
    const option = before.pendingInteraction!.responseOptions[0]!
    const response = { requestId: before.activeRequestId!, nativeRequestId: before.pendingInteraction!.turn.nativeRequestId!, optionId: option.optionId }
    await expect(chat.respond(conversationId, response, stranger)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await chat.respond(conversationId, response, owner)
    expect(manager.responses).toEqual([response.nativeRequestId])
    await expect(chat.cancel(conversationId, before.activeRequestId!, stranger)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await chat.cancel(conversationId, before.activeRequestId!, owner)
    const ended = await chat.get(conversationId, owner)
    expect(ended.conversation.status).toBe('archived')
    expect(ended.activeRequestId).toBeNull()
    expect(ended.messages.some((message) => message.role === 'system' && message.content.startsWith('Automatic Operator review ended:'))).toBe(true)
    const normal = await chat.create(owner, 'Human conversation')
    expect((await chat.get(normal.id, owner)).conversation.status).toBe('open')
    await expect(chat.get(normal.id, stranger)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
  })

  it('fences Stop before new admission, cancels the exact native turn and revokes only review delegation', async () => {
    const normal = await chat.create(owner, 'Unrelated human chat')
    const manager = await startReview()
    const credential = await reviewToken(conversationId)
    expect((await access.authenticate(credential.token)).id).toBe(credential.principal.id)
    await pool.query("insert into run_cleanup_intents(run_id) values('run-one')")
    await expect(access.currentOperator(runAuthority.id)).rejects.toMatchObject({ code: 'AUTH_RUN_ENDED' })
    await chat.stopRunReviews('run-one', 'Run Stop accepted.')
    await chat.stopRunReviews('run-one', 'Repeated Run Stop.')
    const ended = await chat.get(conversationId, owner)
    expect(ended.conversation.status).toBe('archived')
    expect(ended.lastResult?.outcome).toBe('canceled')
    expect(ended.messages.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(manager.cancellations.every((id) => id === 'review-turn-1')).toBe(true)
    expect(manager.turns).toBe(1)
    await expect(access.authenticate(credential.token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect((await access.authenticate(humanToken)).id).toBe(owner.id)
    expect((await chat.get(normal.id, owner)).conversation.status).toBe('open')
    await interaction('interaction-after-stop')
    await expect(chat.reviewInteraction('interaction-after-stop', runAuthority)).rejects.toMatchObject({ code: 'OPERATOR_REVIEW_ENDED' })
    expect(await repository.active('operator-review:interaction-after-stop')).toBeUndefined()
  })

  it('terminates active review work after terminal Run completion and retains the owner-visible transcript', async () => {
    const manager = await startReview()
    await pool.query("update runs set execution_state='completed' where id='run-one'")
    await chat.stopRunReviews('run-one', 'Run completed.')
    expect(manager.cancellations.length).toBeGreaterThan(0)
    expect(manager.disposals).toBeGreaterThan(0)
    expect((await chat.get(conversationId, owner)).conversation.status).toBe('archived')
    expect((await chat.list(owner)).map((item) => item.id)).toContain(conversationId)
    await expect(chat.send(conversationId, { requestId: 'late-new-command', content: 'Continue managing.' }, owner))
      .rejects.toMatchObject({ code: 'CONVERSATION_ARCHIVED' })
  })

  it('denies delegation as soon as the interaction ends, then reconciles cleanup without revoking the human or Run parent', async () => {
    await startReview()
    const credential = await reviewToken(conversationId)
    await pool.query("update durable_interactions set status='canceled',record=jsonb_set(record,'{status}','\"canceled\"') where id='interaction-one'")
    await expect(access.authenticate(credential.token)).rejects.toMatchObject({ code: 'AUTH_REVIEW_ENDED' })
    await chat.reconcileReviewLifetimes()
    await expect(access.authenticate(credential.token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect((await access.currentOperator(runAuthority.id)).id).toBe(runAuthority.id)
    expect((await access.authenticate(humanToken)).id).toBe(owner.id)
    expect((await chat.get(conversationId, owner)).conversation.status).toBe('archived')
  })

  it('does not call a local abort or disposal a successful native cancellation; retains identity and reports uncertain cleanup', async () => {
    const manager = await startReview()
    const credential = await reviewToken(conversationId)
    manager.cancelAcknowledged = false
    await expect(chat.stopRunReviews('run-one')).rejects.toThrow('cleanup remains uncertain')
    const row = await repository.active(conversationId)
    expect(row?.active_request_id).toBe('review:interaction-one')
    expect(row?.active_native_turn_id).toBe('review-turn-1')
    expect(row?.native_session_id).toBe(manager.session.nativeSessionId)
    expect(row?.last_result).toBeNull()
    expect(row?.turn_state).toBe('uncertain')
    expect((await chat.get(conversationId, owner)).conversation.status).toBe('archived')
    await expect(access.authenticate(credential.token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(manager.disposals).toBeGreaterThan(0)
    manager.cancelAcknowledged = true
    await chat.stopRunReviews('run-one', 'Retry native cleanup.')
    expect(manager.attachments).toBeGreaterThan(0)
    expect(manager.turns).toBe(1)
    expect((await chat.get(conversationId, owner)).activeRequestId).toBeNull()
  })
})


describe('F9: invalid Operator settings do not change durable defaults or configuration', () => {
  it('rejects ephemeral Codex before the current Operator version changes in PostgreSQL', async () => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    const operators = new PostgresOperatorRepository(pool)
    const beforeOperator = await operators.ensure()
    const beforeDefaults = await settings.getAgentDefaults()
    const service = new FoundationSettingsManagementService(settings, new PostgresCommandCoordinator(pool),
      { qualifyConfiguration: async () => ({} as never) }, operators)
    const value = structuredClone(beforeDefaults.value)
    value.operator.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex,
      advanced: { ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION), sessionPersistence: 'ephemeral' } }
    await expect(service.updateAgentDefaults(owner, 'http', {
      commandId: 'ephemeral-operator-rejected', expectedRevision: beforeDefaults.revision, value,
    })).rejects.toThrow()
    expect(await settings.getAgentDefaults()).toEqual(beforeDefaults)
    expect(await operators.ensure()).toEqual(beforeOperator)
  })
})
