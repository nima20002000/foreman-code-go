import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_CODEX_ADVANCED_CONFIGURATION, DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type pg from 'pg'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import type { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { PostgresOperatorReviewLifecycle, requireActiveOperatorReviewCredential } from '../src/modules/conversations/operatorReviewLifecycle.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { operator } from './fixtures/agent1OperatorChat.js'

describe('F9: qualification rejects unsupported Operator persistence before changing defaults', () => {
  it('does not touch the current Operator version or settings revision for ephemeral Codex', async () => {
    const persisted = { revision: 7, currentConfigurationVersionId: 'operator-v7', value: structuredClone(DEFAULT_AGENT_DEFAULTS) }
    const before = structuredClone(persisted)
    const updateDefaults = vi.fn(), ensureOperator = vi.fn(), updateOperator = vi.fn()
    const commands = { execute: (input: { perform(client: pg.PoolClient): Promise<unknown> }) => input.perform({} as pg.PoolClient) }
    const service = new FoundationSettingsManagementService(
      { getAgentDefaults: async () => persisted, updateManagedAgentDefaults: updateDefaults } as unknown as PostgresFoundationSettingsRepository,
      commands as unknown as PostgresCommandCoordinator,
      { qualifyConfiguration: vi.fn(async () => ({} as never)) },
      { ensureWithClient: ensureOperator, updateWithClient: updateOperator } as unknown as PostgresOperatorRepository,
    )
    const value = structuredClone(DEFAULT_AGENT_DEFAULTS)
    value.operator.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex,
      advanced: { ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION), sessionPersistence: 'ephemeral' } }
    await expect(service.updateAgentDefaults(operator(), 'http', { commandId: 'reject-ephemeral', expectedRevision: 7, value })).rejects.toThrow()
    expect(updateDefaults).not.toHaveBeenCalled()
    expect(ensureOperator).not.toHaveBeenCalled()
    expect(updateOperator).not.toHaveBeenCalled()
    expect(persisted).toEqual(before)
  })
})

describe('F4: authentication-time Run and review lifetime guards', () => {
  function database(executionState = 'waiting', cleanupPending = false) {
    const human = operator()
    const owner = { id: human.id, name: human.name, audience: 'operator', grants: human.grants,
      expires_at: new Date(human.expiresAt), revoked_at: null, delegated_from: null }
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('from run_authority_principals b')) return { rows: [{ owner_principal_id: owner.id,
        grant_ceiling: owner.grants, accepted_expires_at: owner.expires_at, execution_state: executionState, cleanup_pending: cleanupPending }] }
      return { rows: [values?.[0] === 'run-authority-one' ? { ...owner, id: 'run-authority-one', delegated_from: owner.id } : owner] }
    })
    return { query }
  }
  it.each([['completed', false], ['waiting', true]] as const)('rejects future Run authority in state %s with cleanup=%s', async (state, cleanup) => {
    await expect(currentOperatorAuthority(database(state, cleanup) as unknown as pg.Pool, 'run-authority-one'))
      .rejects.toMatchObject({ code: 'AUTH_RUN_ENDED' })
  })
  it('preserves unrelated root human authority and live Run authority', async () => {
    const db = database('completed', true)
    expect((await currentOperatorAuthority(db as unknown as pg.Pool, 'human-owner')).principal.id).toBe('human-owner')
    expect(db.query).toHaveBeenCalledTimes(1)
    expect((await currentOperatorAuthority(database() as unknown as pg.Pool, 'run-authority-one')).principal.id).toBe('run-authority-one')
  })
  it('denies a review credential immediately when its review ended, before a sweep', async () => {
    const query = vi.fn(async () => ({ rows: [{ active: false }] }))
    await expect(requireActiveOperatorReviewCredential({ query } as unknown as pg.Pool, 'review-credential'))
      .rejects.toMatchObject({ code: 'AUTH_REVIEW_ENDED' })
    expect(query).toHaveBeenCalledWith(expect.stringContaining("r.execution_state='waiting'"), ['review-credential'])
  })
  it('does not apply review-only restrictions to an unrelated human chat credential', async () => {
    await expect(requireActiveOperatorReviewCredential({ query: async () => ({ rows: [] }) } as unknown as pg.Pool, 'human-chat'))
      .resolves.toBeUndefined()
  })
})

describe('F4/F5: durable review lifecycle and access predicates', () => {
  it('commits the parent authority fence before taking child/conversation locks and preserves history on retries', async () => {
    const calls: { sql: string; values?: unknown[] | undefined }[] = []
    let archived = false
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.startsWith('select c.id')) return { rows: [{ id: 'operator-review:interaction-one' }], rowCount: 1 }
      if (sql.startsWith("select record->>'status'")) return { rows: [{ archived }], rowCount: 1 }
      if (sql.startsWith('update operator_conversations set record')) archived = true
      return { rows: [], rowCount: 1 }
    })
    const client = { query, release: vi.fn() }
    const reviews = new PostgresOperatorReviewLifecycle({ connect: async () => client } as unknown as pg.Pool)
    await reviews.stopRun('run-one', 'Run stopped.')
    await reviews.stopRun('run-one', 'Run stopped again.')
    const firstCommit = calls.findIndex((call) => call.sql === 'commit')
    expect(firstCommit).toBeGreaterThan(0)
    expect(calls.findIndex((call) => call.sql.startsWith('select c.id'))).toBeGreaterThan(firstCommit)
    expect(calls.filter((call) => call.sql.startsWith('insert into operator_conversation_messages'))).toHaveLength(1)
    expect(calls.some((call) => /delete from/i.test(call.sql))).toBe(false)
    expect(calls.find((call) => call.sql.includes('update management_principals p'))?.sql).toContain('p.id=b.principal_id')
    expect(calls.find((call) => call.sql.includes('update management_principals p'))?.sql).toContain('p.delegated_from=b.owner_principal_id')
  })
  it('blocks late review admission before inserting a conversation', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void sql; void values
      return { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    const repository = new PostgresOperatorConversationRepository({ connect: async () => client } as unknown as pg.Pool)
    await expect(repository.create('operator', { id: 'v1', operatorId: 'operator', version: 1, harness: DEFAULT_HARNESS_DEFAULTS.codex,
      contentHash: 'sha256:test', createdAt: new Date().toISOString() }, 'revoked-run-principal', 'Review', 'operator-review:interaction-one'))
      .rejects.toMatchObject({ code: 'OPERATOR_REVIEW_ENDED' })
    expect(query.mock.calls.some((call) => String(call[0]).includes('insert into operator_conversations'))).toBe(false)
  })
  it('uses the same exact durable human-owner binding for discovery and summaries', async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void sql; void values
      return { rows: [] }
    })
    const repository = new PostgresOperatorConversationRepository({ query } as unknown as pg.Pool)
    await repository.list('human-owner')
    await repository.summaries('human-owner')
    for (const call of query.mock.calls) {
      expect(call[0]).toEqual(expect.stringContaining("c.id='operator-review:' || i.id"))
      expect(call[1]?.[0]).toBe('human-owner')
      expect(String(call[0])).toContain('c.owner_principal_id=b.principal_id')
      expect(String(call[0])).toContain('b.owner_principal_id=$1')
    }
  })
})
