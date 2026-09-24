import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { readRunHistory } from '../src/modules/runs/runHistory.js'

const url = process.env.FE_R2_001_TEST_DATABASE_URL
describe.skipIf(!url)('persisted historical Run pins', () => {
  it('reads v1 after later v2 topology and Agent configuration are saved', async () => {
    const client = new pg.Client({ connectionString: url! })
    await client.connect()
    try {
      await client.query('begin')
      await client.query(`
        create temporary table runs (id text primary key,workspace_id text,workflow_id text,workflow_version_id text,record jsonb);
        create temporary table workflow_versions (id text primary key,workspace_id text,workflow_id text,record jsonb,
          execution_semantics_version smallint not null default 1);
        create temporary table agent_configuration_versions (id text primary key,workspace_id text,agent_id text,record jsonb);
        create temporary table harness_executions (id text primary key,run_id text,workflow_node_id text,attempt integer,record jsonb,
          unique(run_id,workflow_node_id,attempt));
      `)
      const workspaceId = 'workspace-history', workflowId = 'workflow-history', runId = 'run-history'
      const agentId = 'agent-history', createdAt = '2026-09-24T00:00:00.000Z'
      const configuration = (id: string, reasoningEffort: string) => ({ id, workspaceId, agentId, version: id === 'config-v1' ? 1 : 2,
        prompt: { system: 'SECRET SYSTEM' }, assignedSkills: [], resolvedSkills: [],
        harness: { harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort, sandbox: 'read-only', serviceTier: 'standard' },
        contentHash: 'sha256:test', createdAt })
      await client.query('insert into agent_configuration_versions values($1,$2,$3,$4::jsonb)',
        ['config-v1', workspaceId, agentId, JSON.stringify(configuration('config-v1', 'medium'))])
      const version = (number: number, name: string, configId: string) => ({
        id: `version-v${number}`, workspaceId, workflowId, version: number, entryNodeId: 'node-history',
        agentConfigurationVersionIds: { [agentId]: configId },
        definition: { id: workflowId, workspaceId, name: 'History', version: number,
          executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
          nodes: [{ id: 'node-history', agentId, name, initialPrompt: `SECRET PROMPT ${number}` }], edges: [] },
        contentHash: 'sha256:test', createdAt,
      })
      await client.query('insert into workflow_versions(id,workspace_id,workflow_id,record) values($1,$2,$3,$4::jsonb)',
        ['version-v1', workspaceId, workflowId, JSON.stringify(version(1, 'coder-001', 'config-v1'))])
      const run = { id: runId, workspaceId, workflowId, workflowVersionId: 'version-v1',
        agentConfigurationVersionIds: { [agentId]: 'config-v1' }, executionCondition: { kind: 'manual' },
        executionState: 'completed', outcome: 'succeeded', input: {}, result: { outcome: 'succeeded', output: { text: 'old-result' } },
        createdAt, finishedAt: createdAt }
      await client.query('insert into runs values($1,$2,$3,$4,$5::jsonb)',
        [runId, workspaceId, workflowId, 'version-v1', JSON.stringify(run)])
      const execution = { id: 'execution-v1', runId, workflowNodeId: 'node-history', agentId,
        agentConfigurationVersionId: 'config-v1', attempt: 1, state: 'completed',
        result: { outcome: 'succeeded', output: { text: 'old-result' } }, createdAt, finishedAt: createdAt }
      await client.query('insert into harness_executions values($1,$2,$3,$4,$5::jsonb)',
        [execution.id, runId, execution.workflowNodeId, execution.attempt, JSON.stringify(execution)])
      const read = () => readRunHistory(client as unknown as pg.Pool,
        { workspaceId, workflowId, runId, workflowVersionId: 'version-v1', executionSemanticsVersion: 1 }, true)
      const first = await read()
      expect(first?.nodes[0]?.name).toBe('coder-001')
      expect(first?.agentConfigurations[0]?.reasoningEffort).toBe('medium')
      expect(first?.latestResults[0]?.outputPreview).toBe('old-result')
      await client.query('insert into agent_configuration_versions values($1,$2,$3,$4::jsonb)',
        ['config-v2', workspaceId, agentId, JSON.stringify(configuration('config-v2', 'low'))])
      await client.query('insert into workflow_versions(id,workspace_id,workflow_id,record) values($1,$2,$3,$4::jsonb)',
        ['version-v2', workspaceId, workflowId, JSON.stringify(version(2, 'coder-002-current', 'config-v2'))])
      const afterLaterSave = await read()
      expect(afterLaterSave).toEqual(first)
      expect(JSON.stringify(afterLaterSave)).not.toMatch(/coder-002-current|SECRET|prompt/i)
    } finally {
      await client.query('rollback').catch(() => undefined)
      await client.end()
    }
  })
})
