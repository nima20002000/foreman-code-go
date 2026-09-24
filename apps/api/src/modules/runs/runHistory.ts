import type pg from 'pg'
import { AgentConfigurationVersionSchema, WorkflowRunSchema, WorkflowVersionSchema } from '@graphql/contracts'
import { RunHistoryRequestSchema, RunHistoryResponseSchema, type RunHistoryRequest, type RunHistoryResponse } from '@graphql/contracts/run-history'
import { DomainError } from '../errors.js'

function resultPreview(output: unknown): { outputPreview: string; outputTruncated: boolean } | undefined {
  if (output === undefined) return undefined
  const value = output && typeof output === 'object' && 'text' in output && typeof output.text === 'string'
    ? output.text : typeof output === 'string' ? output : JSON.stringify(output)
  return { outputPreview: value.slice(0, 4_000), outputTruncated: value.length > 4_000 }
}

function legacyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('RUN_IDENTITY_INVALID', 'The saved historical record is invalid.', 409)
  }
  const record: Record<string, unknown> = { ...value as Record<string, unknown> }
  if (record.executionSemanticsVersion !== undefined && record.executionSemanticsVersion !== 1) {
    throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'The historical compatibility read requires saved semantics 1.', 409)
  }
  delete record.executionSemanticsVersion
  return record
}

/** One exact-pin statement. Unlike /current, this is requested once per selected Run. */
export async function readRunHistory(pool: Pick<pg.Pool, 'query'>, input: RunHistoryRequest,
  includeAgentConfiguration: boolean): Promise<RunHistoryResponse | undefined> {
  const scope = RunHistoryRequestSchema.parse(input)
  const result = await pool.query<{ run: unknown; version: unknown; version_pin: number; configurations: unknown[]; latest_results: Array<{
    id: string; runId: string; workflowNodeId: string; agentId: string; agentConfigurationVersionId: string;
    attempt: number; state: string; outcome: string | null; output_preview: string | null; output_truncated: boolean | null
  }> }>(
    `select r.record as run, v.record as version, v.execution_semantics_version as version_pin,
      coalesce((select jsonb_agg(c.record order by pin.key)
        from jsonb_each_text(v.record->'agentConfigurationVersionIds') pin
        join agent_configuration_versions c on c.id=pin.value and c.workspace_id=r.workspace_id
          and c.agent_id=pin.key
        where $5::boolean),'[]'::jsonb) as configurations,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.record->'id','runId',e.record->'runId','workflowNodeId',e.record->'workflowNodeId',
        'agentId',e.record->'agentId','agentConfigurationVersionId',e.record->'agentConfigurationVersionId',
        'attempt',e.record->'attempt','state',e.record->'state','outcome',e.record->'result'->'outcome',
        'output_preview',left(coalesce(e.record #>> '{result,output,text}',e.record #>> '{result,output}'),4000),
        'output_truncated',length(coalesce(e.record #>> '{result,output,text}',e.record #>> '{result,output}'))>4000
      ) order by node.ordinality)
      from jsonb_array_elements(v.record->'definition'->'nodes') with ordinality node(value,ordinality)
      cross join lateral (select e.record from harness_executions e
        where e.run_id=r.id and e.workflow_node_id=node.value->>'id'
        order by e.attempt desc limit 1) e),'[]'::jsonb) as latest_results
     from runs r join workflow_versions v on v.id=r.workflow_version_id
       and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
     where r.workspace_id=$1 and r.workflow_id=$2 and r.id=$3 and r.workflow_version_id=$4`,
    [scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, includeAgentConfiguration],
  )
  const row = result.rows[0]
  if (!row) return undefined
  if (row.version_pin !== 1) {
    throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'The historical compatibility read requires saved semantics 1.', 409)
  }
  const run = WorkflowRunSchema.parse(legacyRecord(row.run))
  const versionRecord = legacyRecord(row.version)
  versionRecord.definition = legacyRecord(versionRecord.definition)
  const version = WorkflowVersionSchema.parse(versionRecord)
  if (run.id !== scope.runId || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
    || run.workflowVersionId !== scope.workflowVersionId || version.id !== scope.workflowVersionId
    || version.workspaceId !== scope.workspaceId || version.workflowId !== scope.workflowId
    || Object.keys(version.agentConfigurationVersionIds).length > 10_000
    || Object.keys(run.agentConfigurationVersionIds).length !== Object.keys(version.agentConfigurationVersionIds).length
    || Object.entries(run.agentConfigurationVersionIds).some(([agentId, id]) => version.agentConfigurationVersionIds[agentId] !== id)) {
    throw new DomainError('RUN_IDENTITY_INVALID', 'The saved Run and historical version do not match.', 409)
  }
  const configurations = row.configurations.map((value) => AgentConfigurationVersionSchema.parse(value))
  const requiredAgentIds = new Set(version.definition.nodes.map((node) => node.agentId))
  const configuredAgentIds = new Set(configurations.map((item) => item.agentId))
  if (includeAgentConfiguration && [...requiredAgentIds].some((agentId) => !configuredAgentIds.has(agentId))) {
    throw new DomainError('RUN_IDENTITY_INVALID', 'A pinned Agent configuration is unavailable.', 409)
  }
  for (const configuration of configurations) {
    if (configuration.workspaceId !== scope.workspaceId
      || version.agentConfigurationVersionIds[configuration.agentId] !== configuration.id) {
      throw new DomainError('RUN_IDENTITY_INVALID', 'A pinned Agent configuration does not match.', 409)
    }
  }
  const nodeById = new Map(version.definition.nodes.map((node) => [node.id, node]))
  const latestResults = row.latest_results.map((item) => {
    const node = nodeById.get(item.workflowNodeId)
    if (!node || item.runId !== run.id || item.agentId !== node.agentId
      || item.agentConfigurationVersionId !== version.agentConfigurationVersionIds[node.agentId]) {
      throw new DomainError('RUN_IDENTITY_INVALID', 'A historical execution does not match its pinned node.', 409)
    }
    return { id: item.id, workflowNodeId: item.workflowNodeId, attempt: item.attempt,
      state: item.state, ...(item.outcome ? { outcome: item.outcome } : {}),
      ...(item.output_preview !== null ? { outputPreview: item.output_preview.slice(0, 4_000),
        outputTruncated: item.output_truncated === true || item.output_preview.length > 4_000 } : {}) }
  })
  return RunHistoryResponseSchema.parse({
    kind: 'legacy-run-history', runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: version.id, executionSemanticsVersion: 1, version: version.version,
    entryNodeId: version.entryNodeId,
    nodes: version.definition.nodes.map((node) => ({ id: node.id, agentId: node.agentId,
      name: node.name ?? node.label!, agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId] })),
    edges: version.definition.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    ...(run.result ? { runResult: { outcome: run.result.outcome, ...resultPreview(run.result.output) } } : {}),
    agentConfigurations: configurations.filter((configuration) => requiredAgentIds.has(configuration.agentId)).map((configuration) => ({ id: configuration.id, agentId: configuration.agentId,
      harness: configuration.harness.harness, model: configuration.harness.model,
      ...(configuration.harness.harness === 'codex'
        ? { reasoningEffort: configuration.harness.reasoningEffort, sandbox: configuration.harness.sandbox,
          serviceTier: configuration.harness.serviceTier }
        : { variant: configuration.harness.variant, nativeAgent: configuration.harness.nativeAgent,
          thinking: configuration.harness.thinking }) })),
    latestResults,
  })
}
