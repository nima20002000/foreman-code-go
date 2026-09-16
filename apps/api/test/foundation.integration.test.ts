import { randomUUID } from 'node:crypto'

import {
  DEFAULT_AGENT_DEFAULTS,
  NATIVE_INTERACTION_FIXTURES,
  WorkflowRunSchema,
  HarnessExecutionSchema,
} from '@graphql/contracts'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

describe('HAP-01 durable foundation', () => {
  it('migrates, versions defaults and preserves stable concurrent identities', async () => {
    const schema = `hap01_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString })
    await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    try {
      await applyApplicationMigrations(pool)
      await applyApplicationMigrations(pool)
      expect((await pool.query<{ version: number }>('select version from application_migrations order by version')).rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 100, 500, 501, 502])
      await ensureAcceptanceSeed(pool)

      const settings = new PostgresFoundationSettingsRepository(pool)
      const original = await settings.getAgentDefaults()
      const changed = structuredClone(DEFAULT_AGENT_DEFAULTS)
      changed.coder.harness = { ...changed.coder.harness, model: 'fixture-next-model' }
      const next = await settings.updateAgentDefaults(changed, original.revision)
      expect(next.versionId).toBeTruthy()
      expect(original.value.coder.harness.model).not.toBe('fixture-next-model')
      await expect(settings.updateAgentDefaults(DEFAULT_AGENT_DEFAULTS, original.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      const competingDefaults = await Promise.allSettled([
        settings.updateWorkflowDefaults({ approvalHandler: 'user' }, 0),
        settings.updateWorkflowDefaults({ approvalHandler: 'operator' }, 0),
      ])
      expect(competingDefaults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(competingDefaults.filter((result) => result.status === 'rejected')).toHaveLength(1)

      const operators = new PostgresOperatorRepository(pool)
      const firstOperator = await operators.ensure()
      const secondOperator = await operators.ensure()
      expect(secondOperator).toEqual(firstOperator)

      const access = new PostgresAccessService(pool)
      await expect(access.issue({ name: 'invalid worker', audience: 'worker', grants: [], expiresAt: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: 'WORKER_AGENT_REQUIRED' })
      const worker = await access.issue({ name: 'coder', audience: 'worker', agentId: 'agent-developer', grants: [], expiresAt: new Date(Date.now() + 60_000) })
      expect((await access.authenticate(worker.token, 'worker')).agentId).toBe('agent-developer')
      await expect(access.authenticate(worker.token, 'operator')).rejects.toMatchObject({ code: 'AUTH_WRONG_AUDIENCE' })

      const run = WorkflowRunSchema.parse({
        id: 'run-hap01', workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline',
        workflowVersionId: 'workflow-content-pipeline-v1', agentConfigurationVersionIds: {},
        executionCondition: { kind: 'manual' }, executionState: 'waiting', outcome: 'pending', input: {},
        createdAt: '2026-09-16T00:00:00.000Z',
      })
      await pool.query(`insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
        values ($1,$2,$3,$4,$5,$6::jsonb)`, [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, run.executionState, JSON.stringify(run)])
      const runs = new PostgresRunRepository(pool, {} as never, {} as never)
      const occurrence = HarnessExecutionSchema.parse({
        id: 'execution-hap01-a', runId: run.id, workflowNodeId: 'node-developer', agentId: 'agent-developer',
        agentConfigurationVersionId: 'agent-developer-config-v1', attempt: 1, input: {}, state: 'waiting',
        createdAt: '2026-09-16T00:00:00.000Z',
      })
      expect((await runs.ensureExecution(occurrence)).created).toBe(true)
      const reentry = await runs.ensureExecution({ ...occurrence, id: 'execution-hap01-b' })
      expect(reentry).toMatchObject({ created: false, execution: { id: 'execution-hap01-a' } })

      const interactions = new PostgresInteractionRepository(pool)
      const base = {
        ...NATIVE_INTERACTION_FIXTURES.codex,
        workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline', runId: run.id,
        executionId: occurrence.id, requestingAgentId: 'agent-developer',
        approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'agent-researcher' },
      }
      const [left, right] = await Promise.all([
        interactions.create({ ...base, id: 'interaction-hap01-a' }),
        interactions.create({ ...base, id: 'interaction-hap01-b' }),
      ])
      expect([left.created, right.created].sort()).toEqual([false, true])
      const persisted = left.interaction
      const decisions = await Promise.allSettled([
        interactions.decide({ id: persisted.id, optionId: 'codex-approve-once', expectedRevision: 0, nativeResponse: { decision: 'accept' } }),
        interactions.decide({ id: persisted.id, optionId: 'codex-reject', expectedRevision: 0, nativeResponse: { decision: 'decline' } }),
      ])
      expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(decisions.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const decided = await interactions.get(persisted.id)
      expect(decided).toMatchObject({ revision: 1, status: 'delivery_pending' })
    } finally {
      await pool.end()
      await admin.query(`drop schema if exists "${schema}" cascade`)
      await admin.end()
    }
  }, 30_000)
})
