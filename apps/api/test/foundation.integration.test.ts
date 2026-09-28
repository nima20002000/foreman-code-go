import { randomUUID } from 'node:crypto'

import { DEFAULT_AGENT_DEFAULTS } from '@graphql/contracts'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'

const connectionString = process.env.TEST_DATABASE_URL

describe.skipIf(!connectionString)('HAP-01 durable foundation', () => {
  it('migrates, versions defaults and preserves stable operator identities', async () => {
    let database: URL
    try { database = new URL(connectionString!) } catch { throw new Error('Use a loopback PostgreSQL database explicitly named for tests') }
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
      || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
    const schema = `hap01_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString })
    await admin.query(`create schema "${schema}"`)
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    try {
      await applyApplicationMigrations(pool)
      await applyApplicationMigrations(pool)
      expect((await pool.query<{ version: number }>('select version from application_migrations order by version')).rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 100, 400, 401, 500, 501, 502, 503, 507, 508, 509, 700, 701, 800, 1701, 1702, 170017, 170018, 170019, 170020, 170021, 170022, 170023, 170024, 170025, 170026, 250001, 250002, 250003, 250005, 264201, 264401, 264402, 264403, 264404, 264405, 264501, 264502, 264601, 264602, 264603, 264604, 264701, 265501, 265502, 267201, 267202, 267203, 268201, 269301, 269401, 269501, 270203, 270204, 270205, 273601, 273605, 273636, 273637, 273640, 278001, 26090501])
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
        settings.updateWorkflowDefaults({ approvalHandler: 'user' }, 0),
      ])
      expect(competingDefaults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(competingDefaults.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const workflowDefaults = await settings.getWorkflowDefaults()
      await settings.updateWorkflowDefaults({ approvalHandler: 'user' }, workflowDefaults.revision)
      const workflows = new WorkflowManagementService(pool, new PostgresCommandCoordinator(pool))
      const access = new PostgresAccessService(pool)
      const principal = (await access.issue({
        name: 'Settings copy proof', audience: 'operator',
        grants: [{ actions: ['workflows:create', 'workflows:read'], scope: { workspaceIds: ['workspace-1'] } }],
        expiresAt: new Date(Date.now() + 60_000),
      })).principal
      const createdWorkflow = await workflows.create(principal, 'http', {
        workspaceId: 'workspace-1', commandId: 'settings-copy-workflow', name: 'Copied workflow defaults',
      })
      expect(createdWorkflow.value.workflow.approval).toEqual({ handler: 'user' })
      const nextWorkflowDefaults = await settings.getWorkflowDefaults()
      await settings.updateWorkflowDefaults({ approvalHandler: 'user' }, nextWorkflowDefaults.revision)
      expect((await workflows.get(principal, 'workspace-1', createdWorkflow.value.workflow.id)).workflow.approval).toEqual({ handler: 'user' })

      const operators = new PostgresOperatorRepository(pool)
      const firstOperator = await operators.ensure()
      const secondOperator = await operators.ensure()
      expect(secondOperator).toEqual(firstOperator)

      await expect(access.issue({ name: 'invalid worker', audience: 'worker', grants: [], expiresAt: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: 'WORKER_AGENT_REQUIRED' })
      const worker = await access.issue({ name: 'coder', audience: 'worker', agentId: 'agent-developer', grants: [], expiresAt: new Date(Date.now() + 60_000) })
      expect(worker.principal.agentId).toBe('agent-developer')
      await expect(access.authenticate(worker.token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      await expect(access.authenticate(worker.token, 'operator')).rejects.toMatchObject({ code: 'AUTH_WRONG_AUDIENCE' })

    } finally {
      await pool.end()
      await admin.query(`drop schema if exists "${schema}" cascade`)
      await admin.end()
    }
  }, 30_000)
})
