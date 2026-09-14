import {
  AgentSchema,
  WorkspaceDetailsResponseSchema,
  WorkspaceSchema,
  type Agent,
  type WorkspaceDetailsResponse,
} from '@graphql/contracts'
import type pg from 'pg'

import type { PostgresRunRepository } from '../runs/postgres.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'

export class PostgresWorkspaceRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly runs: PostgresRunRepository,
  ) {}

  async listAgents(workspaceId: string): Promise<Agent[]> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agents where workspace_id = $1 order by created_at, id',
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

  async getDetails(workspaceId: string): Promise<WorkspaceDetailsResponse | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from workspaces where id = $1', [workspaceId])
    if (!result.rows[0]) return undefined
    return WorkspaceDetailsResponseSchema.parse({
      workspace: WorkspaceSchema.parse(result.rows[0].record),
      agents: await this.listAgents(workspaceId),
      workflows: await this.workflows.list(workspaceId),
      runs: await this.runs.listSummaries(workspaceId),
      resources: [],
      runners: [{
        id: 'runner-local',
        name: 'Local Runner',
        health: { status: 'healthy', checkedAt: new Date().toISOString() },
      }],
    })
  }
}
