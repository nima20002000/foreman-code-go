import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings } from '@graphql/contracts'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

it('pins the full cross-harness Operator configuration and preserves it on exact retries', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/postgres' })
  const schema = `pr18_pin_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ ...admin.options, max: 1, options: `-c search_path=${schema}` })
  try {
    await applyApplicationMigrations(pool)
    const principal = (await new PostgresAccessService(pool).issue({ name: 'owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })).principal
    const operators = new PostgresOperatorRepository(pool)
    const repository = new PostgresOperatorConversationRepository(pool)
    const initial = await operators.ensure()
    const conversation = await repository.create(initial.operator.id, initial.configuration, principal.id)
    const intended = { ...DEFAULT_HARNESS_DEFAULTS.opencode, nativeAgent: 'review-only',
      advanced: { ...DEFAULT_HARNESS_DEFAULTS.opencode.advanced!,
        permissionRules: [{ permission: 'bash', pattern: '*', action: 'deny' as const }],
        mcp: { serverEnabled: { unrelated: false } } } }
    await operators.update(intended, initial.configuration.id)
    const input = { requestId: randomUUID(), content: 'Inspect without writes', settings: operatorChatSettings(intended) }
    const accepted = await repository.beginTurn(conversation.id, input, principal.id)
    const pin = accepted.state.conversation.operatorConfigurationVersionId!
    expect((await repository.configuration(pin))?.harness).toEqual(intended)
    expect(await repository.acceptedConfiguration(conversation.id, input.requestId)).toMatchObject({ id: pin, harness: intended })
    await repository.finish(conversation.id, input.requestId, { outcome: 'failed', error: { code: 'PRE_WRITE', message: 'not submitted', retryable: true } }, undefined, true)
    const current = await operators.ensure()
    await operators.update({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'changed-after-acceptance' }, current.configuration.id)
    const retry = await repository.beginTurn(conversation.id, input, principal.id)
    expect(retry.state.conversation.operatorConfigurationVersionId).toBe(pin)
    expect((await repository.configuration(pin))?.harness).toEqual(intended)
    await expect(repository.beginTurn(conversation.id, { ...input, content: 'changed' }, principal.id)).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect((await pool.query('select request_id from operator_conversation_turns')).rowCount).toBe(1)
  } finally { await pool.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end() }
}, 30_000)
