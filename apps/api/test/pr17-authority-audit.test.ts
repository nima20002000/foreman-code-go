import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import type pg from 'pg'
import type { DurableInteraction } from '@graphql/contracts'
import { ManagementPrincipalSchema } from '@graphql/contracts/management'
import { DomainError } from '../src/modules/errors.js'
import { acceptRunAuthority, bindRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'

function interaction(): DurableInteraction {
  return { id: 'interaction-proof', revision: 0, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'coder', harness: 'codex', providerVersion: '0.154.0',
    nativeSessionId: 'session', nativeRequestId: 'request', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: 'run', request: { command: 'test' },
    approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' },
    responseOptions: [{ optionId: 'choice', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' }
}
const principal = () => ManagementPrincipalSchema.parse({ id: 'worker', name: 'Reviewer', audience: 'worker', agentId: 'reviewer',
  grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }],
  expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null })

for (const revoked of [true, false]) it(`F03: production App service retains transactional worker authority and audit; revoked=${revoked}`, async () => {
  let record = interaction()
  const actor = principal()
  const client = { query: vi.fn() } as unknown as pg.PoolClient
  const recordAudit = vi.fn(async () => undefined)
  const commands = { recordAudit, recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const decide = vi.fn(async (input: Parameters<PostgresInteractionRepository['decide']>[0]) => {
    assert.equal(input.principal?.id, actor.id, 'production must not drop the authenticated worker principal')
    assert(input.beforeCommit, 'the successful management audit belongs to the decision transaction')
    if (revoked) throw new DomainError('AUTH_REVOKED', 'The live binding was revoked before commit.', 401)
    record = { ...record, revision: 1, selectedOptionId: 'choice', selectedSemantic: 'approve_once', nativeResponse: null,
      decidedAt: '2026-09-16T00:00:01.000Z', status: 'delivery_pending', deliveryState: 'pending' }
    const value = { interaction: structuredClone(record), replayed: false }
    await input.beforeCommit(client, value)
    return value
  })
  const repository = { get: async () => structuredClone(record), decide, delivery: { claim: async () => undefined } } as unknown as PostgresInteractionRepository
  const budgets = { assertActive: async () => undefined } as unknown as PostgresApprovalBudgetRepository
  const attach = vi.fn()
  const native = { attachInteraction: attach } as unknown as InteractionNativeRuntime
  const orchestration = new InteractionService(repository, budgets, native, async () => undefined)
  const app = new PostgresAppInteractionService({} as pg.Pool, repository, commands, orchestration)
  const action = app.respond(actor, { interactionId: record.id, optionId: 'choice', expectedRevision: 0 })
  if (revoked) {
    await assert.rejects(action, (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
    assert.equal(record.selectedOptionId, undefined)
    assert(!recordAudit.mock.calls.some((call) => (call as unknown[])[4] === 'succeeded'))
  } else {
    assert.equal((await action).interaction.selectedOptionId, 'choice')
    assert.equal(recordAudit.mock.calls.length, 1, 'no second, post-commit successful audit')
    assert.equal((recordAudit.mock.calls[0] as unknown[])[6], client)
  }
  assert.equal(attach.mock.calls.length, 0)
})

function authorityDatabase() {
  const expires = new Date(Date.now() + 3_600_000)
  const rows = new Map<string, Record<string, unknown>>([
    ['owner', { id: 'owner', name: 'Owner', audience: 'operator', revoked_at: null, delegated_from: null, expires_at: expires,
      grants: [{ actions: ['runs:start', 'workspace_locations:read', 'operator_chat:write'], scope: { workspaceIds: ['workspace'] } }] }],
    ['chat', { id: 'chat', name: 'Chat transport', audience: 'operator', revoked_at: null, delegated_from: 'owner', expires_at: expires,
      grants: [{ actions: ['runs:start', 'workspace_locations:read'], scope: { workspaceIds: ['workspace'] } }] }],
  ])
  const bindings = new Map<string, Record<string, unknown>>()
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('select id,name,audience,grants')) return { rows: rows.has(String(values[0])) ? [rows.get(String(values[0]))!] : [], rowCount: 1 }
    if (sql.includes('from run_authority_principals')) return { rows: bindings.has(String(values[0])) ? [bindings.get(String(values[0]))!] : [], rowCount: 1 }
    if (sql.startsWith('select id from management_principals')) return { rows: [], rowCount: 0 }
    if (sql.startsWith('insert into management_principals')) {
      rows.set(String(values[0]), { id: values[0], name: values[1], audience: 'operator', revoked_at: null,
        grants: JSON.parse(String(values[3])), expires_at: new Date(String(values[4])), delegated_from: values[5] })
      assert.match(String(values[2]), /^[0-9a-f]{64}$/)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('insert into run_authority_principals')) {
      bindings.set(String(values[0]), { owner_principal_id: values[2], caller_principal_id: values[3],
        grant_ceiling: JSON.parse(String(values[4])), accepted_expires_at: new Date(String(values[5])) })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected authority query: ${sql}`)
  }
  const db = { query } as unknown as pg.PoolClient
  const row = rows.get('chat')!
  const caller = ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: row.audience, grants: row.grants,
    expiresAt: expires.toISOString(), revokedAt: null })
  return { rows, bindings, db, caller }
}

it('F04: chat release cannot revoke the Run snapshot, but human-owner revocation still can', async () => {
  const h = authorityDatabase()
  const accepted = await acceptRunAuthority(h.db, h.caller, true)
  assert.equal(accepted.callerId, 'chat')
  assert.equal(accepted.ownerId, 'owner')
  await bindRunAuthority(h.db, 'run', accepted)
  h.rows.get('chat')!.revoked_at = new Date()
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert.equal(current.owner.id, 'owner')
  assert(current.principal.grants.some((grant) => grant.actions.includes('runs:start')))
  h.rows.get('owner')!.revoked_at = new Date()
  await assert.rejects(currentOperatorAuthority(h.db, accepted.principal.id), (error: unknown) => error instanceof DomainError && error.code === 'AUTH_REVOKED')
})

it('F04: both the accepted grant ceiling and the owner’s current narrower permissions apply', async () => {
  const h = authorityDatabase()
  const accepted = await acceptRunAuthority(h.db, h.caller, false)
  await bindRunAuthority(h.db, 'run', accepted)
  h.rows.get('owner')!.grants = [{ actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: ['workspace', 'another'] } }]
  const current = await currentOperatorAuthority(h.db, accepted.principal.id)
  assert(!current.principal.grants.some((grant) => grant.actions.includes('workspace_locations:read') || grant.actions.includes('runs:stop')))
  assert(current.principal.grants.every((grant) => !grant.scope.workspaceIds?.includes('another')))
  assert(Date.parse(current.principal.expiresAt) <= Date.parse(accepted.principal.expiresAt))
})

it('F04: an ordinary delegated chat principal is not accepted as durable Run authority', async () => {
  const h = authorityDatabase()
  await assert.rejects(currentOperatorAuthority(h.db, 'chat'), (error: unknown) => error instanceof DomainError && error.code === 'AUTH_INVALID')
})
