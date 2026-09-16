import type { DurableInteraction } from '@graphql/contracts'
import type pg from 'pg'

/** Relational owners for storage/authorization fixtures; no runnable workflow is fabricated. */
export async function seedInteractionOwners(pool: pg.Pool, interaction: DurableInteraction): Promise<void> {
  const versionId = `${interaction.workflowId}-storage-version`
  await pool.query("insert into workspaces (id,record) values ($1,'{}') on conflict do nothing", [interaction.workspaceId])
  await pool.query("insert into workflows (id,workspace_id,record) values ($1,$2,'{}') on conflict do nothing", [interaction.workflowId, interaction.workspaceId])
  await pool.query("insert into workflow_versions (id,workspace_id,workflow_id,version,entry_node_id,record) values ($1,$2,$3,1,'storage-node','{}') on conflict do nothing", [versionId, interaction.workspaceId, interaction.workflowId])
  await pool.query("insert into runs (id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values ($1,$2,$3,$4,'waiting','{}') on conflict do nothing", [interaction.runId, interaction.workspaceId, interaction.workflowId, versionId])
  await pool.query("insert into agents (id,workspace_id,record) values ($1,$2,'{}') on conflict do nothing", [interaction.requestingAgentId, interaction.workspaceId])
  await pool.query("insert into harness_executions (id,run_id,workflow_node_id,agent_id,attempt,record) values ($1,$2,$3,$4,1,'{\"state\":\"waiting\"}') on conflict do nothing", [interaction.executionId, interaction.runId, `node-${interaction.executionId}`, interaction.requestingAgentId])
}
