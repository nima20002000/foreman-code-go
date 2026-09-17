import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HARNESS_DEFAULTS,
  type Agent,
  type WorkflowDefinition,
} from '@graphql/contracts'
import type pg from 'pg'

import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { configurationInput } from '../src/modules/workspaces/agentConfiguration.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'

const workspaceId = 'workspace-pr3'
const workflow: WorkflowDefinition = {
  id: 'workflow-pr3', workspaceId, name: 'Regression workflow',
  executionCondition: { kind: 'manual' },
  nodes: [{ id: 'node-one', agentId: 'agent-one', name: 'Agent' }], edges: [],
}

function staleClient() {
  const newer: Agent = {
    id: 'agent-one', name: 'Agent', harness: 'codex', model: 'gpt-5.6-terra',
    configurationVersionId: 'configuration-new',
  }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from workspaces')) return { rows: [{ id: workspaceId }], rowCount: 1 }
    if (sql.includes('from agents where id = $1')) return {
      rows: [{ workspace_id: workspaceId, current_configuration_version_id: newer.configurationVersionId, record: newer }],
      rowCount: 1,
    }
    return { rows: [], rowCount: 0 }
  })
  const release = vi.fn()
  const client = { query, release } as unknown as pg.PoolClient
  const pool = { connect: async () => client } as unknown as pg.Pool
  return { query, release, pool, newer }
}

describe('PR #3 agent persistence regressions', () => {
  it.each(['configuration-old', undefined])('rejects stale board version %s before any writes', async (configurationVersionId) => {
    const { pool, query, release, newer } = staleClient()
    const old: Agent = { ...newer, name: 'Older editor rename', model: 'gpt-5.6-luna', configurationVersionId }
    await expect(new PostgresWorkflowRepository(pool).save(workspaceId, workflow, [old]))
      .rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_CONFLICT', status: 409 })
    expect(query.mock.calls.some(([sql]) => /^\s*(insert|update|delete)\b/i.test(sql))).toBe(false)
    expect(query).toHaveBeenLastCalledWith('rollback')
    expect(newer.model).toBe('gpt-5.6-terra')
    expect(release).toHaveBeenCalledOnce()
  })

  it('uses advisory-then-row locking for standalone saves as well', async () => {
    const { pool, query, newer } = staleClient()
    const workflows = new PostgresWorkflowRepository(pool)
    const repository = new PostgresWorkspaceRepository(pool, workflows, {} as PostgresRunRepository)
    await expect(repository.saveAgent(workspaceId, newer.id, { ...newer, configurationVersionId: 'old' }))
      .rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_CONFLICT', status: 409 })
    const sql = query.mock.calls.map(([statement]) => statement)
    expect(sql.findIndex((statement) => statement.includes('pg_advisory_xact_lock')))
      .toBeLessThan(sql.findIndex((statement) => statement.includes('from agents')))
    expect(sql.find((statement) => statement.includes('from agents'))).toContain('for update')
  })

  it('honors the nested-only OpenCode discriminator and rejects contradictory harnesses', () => {
    const nested: Agent = { id: 'new-agent', name: 'OpenCode', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.opencode }
    expect(configurationInput(workspaceId, nested).harness).toEqual(DEFAULT_HARNESS_DEFAULTS.opencode)
    expect(() => configurationInput(workspaceId, { ...nested, harness: 'codex' }))
      .toThrow(expect.objectContaining({ code: 'AGENT_HARNESS_MISMATCH', status: 400 }))
  })

})
