import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import type { AcceptedExecutionBinding } from '../src/modules/placement/nativeComposition.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { prepareRemoteOwnerControl } from '../src/modules/runs/remote/ownerControl.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'

it('closes a persisted completed retained reviewer only after its reviews settle', async () => {
  const database = await migratedDatabase()
  const schema = `reviewer_close_${randomUUID().replaceAll('-', '')}`
  const pool = new pg.Pool({ connectionString: database.databaseUrl, options: `-c search_path=${schema}` })
  let owner: RunOwnership | undefined
  let schemaCreated = false
  try {
    await createFixtureSchema(database.pool, schema)
    schemaCreated = true
    // Copy migrated columns and defaults without unrelated foreign-key fixtures.
    for (const table of ['harness_executions', 'review_jobs', 'remote_execution_receipts',
      'run_cleanup_intents', 'run_checkpoint_owners']) {
      await pool.query(`create table ${table} (like public.${table} including defaults including indexes)`)
    }
    const native = { sessionId: 'reviewer-session', turnId: 'workflow-turn', processIdentityDigest: 'a'.repeat(64) }
    const mainId = randomUUID()
    const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1,
      intent: { schemaVersion: 1, protocolVersion: 1, mainId, runId: 'run', nodeId: 'reviewer',
        executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
        attemptId: 'attempt', operationId: 'operation', bindingHash: 'a'.repeat(64),
        inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } },
      native, connection: { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
        bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
      workerIncarnationId: randomUUID(), sequence: 5, phase: 'running', entryAttempted: true,
      turnEntryAttempted: true, stopFence: false, controls: [],
      turnInput: { correlationId: 'execution:execution', promptDigest: 'a'.repeat(64), sessionMode: 'regular' },
      retainedReviewer: { agentId: 'agent', workflowTurnId: native.turnId, result: { outcome: 'succeeded' },
        expiresAt: new Date(Date.now() + 300_000).toISOString() },
    })
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values('execution','run','reviewer','agent',1,$1::jsonb)`, [JSON.stringify({ state: 'completed' })])
    await pool.query('insert into remote_execution_receipts(operation_id,sequence,receipt) values($1,$2,$3::jsonb)',
      [receipt.intent.operationId, receipt.sequence, JSON.stringify(receipt)])
    owner = await RunOwnership.acquire(pool, receipt.intent.runId, () => {})
    if (!owner) throw new Error('The fixture Run owner was not acquired.')
    const currentOwner = owner
    const binding = {
      intent: receipt.intent, placement: { bindingHash: receipt.intent.bindingHash },
    } as AcceptedExecutionBinding
    const close = () => currentOwner.oneShotConnection().transaction(sql =>
      prepareRemoteOwnerControl(sql, currentOwner, binding, { kind: 'stop', native }))
    const command = await close()
    expect(command).toMatchObject({ commandId: 'close-reviewer:operation', executionId: 'execution', native,
      owner: receipt.intent.owner, action: { kind: 'stop' } })
    expect(await close()).toEqual(command)

    await pool.query(`update harness_executions set record=$1::jsonb where id='execution'`,
      [JSON.stringify({ state: 'running' })])
    await expect(close()).rejects.toMatchObject({ code: 'REMOTE_CONTROL_UNAVAILABLE' })
    await pool.query(`update harness_executions set record=$1::jsonb where id='execution'`,
      [JSON.stringify({ state: 'completed' })])
    await pool.query(`insert into review_jobs(id,interaction_id,reviewer_agent_id,execution_id,state,record)
      values('review','interaction','agent','execution','acknowledged','{}'::jsonb)`)
    await expect(close()).rejects.toMatchObject({ code: 'REMOTE_CONTROL_UNAVAILABLE' })
    await pool.query(`update review_jobs set state='failed' where id='review'`)
    await expect(close()).rejects.toMatchObject({ code: 'REMOTE_CONTROL_UNAVAILABLE' })
    await pool.query(`update review_jobs set record=$1::jsonb where id='review'`,
      [JSON.stringify({ cleanup: { completedAt: new Date().toISOString() } })])
    expect(await close()).toEqual(command)
    await pool.query(`update review_jobs set state='completed',record='{}'::jsonb where id='review'`)
    expect(await close()).toEqual(command)
    expect((await pool.query('select run_id from run_cleanup_intents')).rows).toEqual([])
  } finally {
    try { await owner?.release() }
    finally {
      await pool.end()
      try { if (schemaCreated) await dropFixtureSchema(database.pool, schema) }
      finally { await database.close() }
    }
  }
})
