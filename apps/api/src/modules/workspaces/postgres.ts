import {
  AgentSchema,
  WorkspaceSchema,
  type Agent,
} from '@graphql/contracts'
import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { withCurrentRunRead } from '../runs/currentRead.js'
import { SavedWorkspaceDetailsSchema, type SavedWorkspaceDetails } from '@graphql/contracts/wave25'

import { DomainError } from '../errors.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { saveAgentConfiguration } from './agentConfiguration.js'

export class PostgresWorkspaceRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    _runs: PostgresRunRepository,
  ) {}

  async listAgents(workspaceId: string): Promise<Agent[]> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agents where workspace_id = $1 and archived_at is null order by created_at, id',
      [workspaceId],
    )
    return result.rows.map((row) => AgentSchema.parse(row.record))
  }

  async getAgent(workspaceId: string, agentId: string): Promise<Agent | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agents where workspace_id = $1 and id = $2',
      [workspaceId, agentId],
    )
    return result.rows[0] ? AgentSchema.parse(result.rows[0].record) : undefined
  }

  async saveAgent(workspaceId: string, agentId: string, input: Agent): Promise<Agent> {
    if (input.id !== agentId) throw new DomainError('INVALID_AGENT', 'The agent ID does not match the requested agent.', 400)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const agent = await saveAgentConfiguration(client, workspaceId, input, true)
      await client.query('commit')
      return agent
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async getDetails(workspaceId: string, principal?: ManagementPrincipal): Promise<SavedWorkspaceDetails | undefined> {
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Workspace readback requires an authenticated management caller.', 401)
    for (const action of ['workspaces:read', 'workflows:read', 'agents:read', 'runs:read'] as const) {
      requireAuthorization(principal, action, { workspaceId })
    }
    const result = await this.pool.query<{ record: unknown }>('select record from workspaces where id = $1', [workspaceId])
    if (!result.rows[0]) return undefined
    return SavedWorkspaceDetailsSchema.parse({
      workspace: WorkspaceSchema.parse(result.rows[0].record),
      agents: await this.listAgents(workspaceId),
      workflows: await this.workflows.list(workspaceId),
      runs: await this.currentSummaries(workspaceId, principal),
      resources: [],
      runners: [{
        id: 'runner-local',
        name: 'Local Runner',
        health: { status: 'healthy', checkedAt: new Date().toISOString() },
      }],
    })
  }
  private async currentSummaries(workspaceId: string, principal: ManagementPrincipal) {
    const rows = (await this.pool.query<{ id: string }>(
      `select r.id from runs r where r.workspace_id=$1 and (r.execution_state<>'completed'
        or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
        or r.id in (select recent.id from runs recent where recent.workspace_id=$1 order by recent.created_at desc,recent.id desc limit 20))
       order by r.created_at desc,r.id desc limit 2001`, [workspaceId])).rows
    if (rows.length > 2000) throw new DomainError('WORKSPACE_RUN_READ_TOO_LARGE', 'Use the bounded management Run pages for this workspace.', 409)
    const summaries = []
    for (const { id } of rows) summaries.push(await withCurrentRunRead(this.pool, principal, workspaceId, id, 'runs:read',
      async (_sql, { run, cleanupPending }) => ({
        id: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId, executionCondition: run.executionCondition,
        executionState: run.executionState, outcome: run.outcome, authRequired: false, browserWait: null, cleanupPending,
        ...(run.stopCause ? { stopCause: run.stopCause } : {}),
        runnerHealth: { status: 'healthy' as const, checkedAt: new Date().toISOString() },
        ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      })))
    return summaries
  }

}
