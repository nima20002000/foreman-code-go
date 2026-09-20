import type pg from 'pg'

/** Give isolated legacy transport fixtures a valid immutable routed-approval graph. */
export async function seedOrchestratorApproval(pool: pg.Pool): Promise<void> {
  const approval = JSON.stringify({ handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-reviewer' })
  await pool.query(`update workflow_versions set record = jsonb_set(
    jsonb_set(record, '{approval}', $1::jsonb, true), '{definition,approval}', $1::jsonb, true)
    where id = 'workflow-content-pipeline-v1'`, [approval])
  await pool.query(`update agent_configuration_versions set record = jsonb_set(record, '{productRole}', '"orchestrator"'::jsonb, true)
    where id = 'agent-reviewer-config-v1'`)
}
