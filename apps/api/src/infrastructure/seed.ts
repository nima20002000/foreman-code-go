import { createHash } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  WorkspaceSchema,
  type AgentConfigurationVersion,
} from '@graphql/contracts'
import type pg from 'pg'

function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

const seededAt = '2026-09-14T00:00:00.000Z'

const workspace = WorkspaceSchema.parse({
  id: 'workspace-1',
  name: 'Website',
  description: 'Real local workflow-engine workspace.',
  agentIds: ['agent-researcher', 'agent-developer', 'agent-reviewer'],
  workflowIds: ['workflow-content-pipeline'],
  createdAt: seededAt,
  updatedAt: seededAt,
})

const configurations = [
  {
    id: 'agent-researcher-config-v1',
    workspaceId: workspace.id,
    agentId: 'agent-researcher',
    version: 1,
    prompt: {
      system: 'Produce exactly three concise facts about honeybees. Use general knowledge only and return plain text.',
    },
    assignedSkills: [],
    harness: {
      harness: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      sandbox: 'read-only',
      serviceTier: 'standard',
    },
    createdAt: seededAt,
  },
  {
    id: 'agent-developer-config-v1',
    workspaceId: workspace.id,
    agentId: 'agent-developer',
    version: 1,
    prompt: {
      system: 'Turn only the supplied prior result into a short factual summary. Do not research or use files.',
    },
    assignedSkills: [],
    harness: {
      harness: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'max',
      nativeAgent: 'build',
      thinking: false,
      autoApprove: false,
    },
    createdAt: seededAt,
  },
  {
    id: 'agent-reviewer-config-v1',
    workspaceId: workspace.id,
    agentId: 'agent-reviewer',
    version: 1,
    prompt: {
      system: 'Review only the supplied summary and produce a polished final response. Do not research or use files.',
    },
    assignedSkills: [],
    harness: {
      harness: 'codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      sandbox: 'read-only',
      serviceTier: 'standard',
    },
    createdAt: seededAt,
  },
] satisfies Array<Omit<AgentConfigurationVersion, 'contentHash'>>

const parsedConfigurations = configurations.map((configuration) =>
  AgentConfigurationVersionSchema.parse({
    ...configuration,
    contentHash: contentHash(configuration),
  }),
)

const agents = [
  AgentSchema.parse({
    id: 'agent-researcher',
    name: 'Researcher',
    role: 'researcher',
    description: 'Produces the first real workflow result.',
    status: 'available',
    executionState: 'available',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'low',
    fastMode: false,
    configurationVersionId: 'agent-researcher-config-v1',
    prompt: parsedConfigurations[0]!.prompt,
    assignedSkills: [],
  }),
  AgentSchema.parse({
    id: 'agent-developer',
    name: 'Summarizer',
    role: 'writer',
    description: 'Receives the stored first result through OpenCode.',
    status: 'available',
    executionState: 'available',
    harness: 'opencode',
    model: 'opencode-go/deepseek-v4.1-flash',
    effort: 'max',
    configurationVersionId: 'agent-developer-config-v1',
    prompt: parsedConfigurations[1]!.prompt,
    assignedSkills: [],
  }),
  AgentSchema.parse({
    id: 'agent-reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    description: 'Reviews the stored summary and produces the final result.',
    status: 'available',
    executionState: 'available',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'medium',
    fastMode: false,
    configurationVersionId: 'agent-reviewer-config-v1',
    prompt: parsedConfigurations[2]!.prompt,
    assignedSkills: [],
  }),
]

const workflow = WorkflowDefinitionSchema.parse({
  id: 'workflow-content-pipeline',
  workspaceId: workspace.id,
  name: 'Real three-agent handoff',
  description: 'Codex produces facts, OpenCode summarizes them, and Codex reviews the stored summary.',
  executionCondition: { kind: 'manual', description: 'Started by the operator.' },
  nodes: [
    { id: 'node-researcher', agentId: 'agent-researcher', name: 'Researcher', position: { x: 120, y: 160 } },
    { id: 'node-developer', agentId: 'agent-developer', name: 'Summarizer', position: { x: 400, y: 160 } },
    { id: 'node-reviewer', agentId: 'agent-reviewer', name: 'Reviewer', position: { x: 680, y: 160 } },
  ],
  edges: [
    {
      id: 'edge-researcher-developer',
      source: 'node-researcher',
      target: 'node-developer',
      label: 'Stored result handoff',
      route: { outcomes: ['succeeded'] },
    },
    {
      id: 'edge-developer-reviewer',
      source: 'node-developer',
      target: 'node-reviewer',
      label: 'Stored result handoff',
      route: { outcomes: ['succeeded'] },
    },
  ],
  version: 1,
  executionPolicy: { maxParallelism: 3, maxNodeExecutions: 3 },
  createdAt: seededAt,
  updatedAt: seededAt,
})

const workflowVersion = WorkflowVersionSchema.parse({
  id: `${workflow.id}-v1`,
  workspaceId: workspace.id,
  workflowId: workflow.id,
  version: 1,
  entryNodeId: workflow.nodes[0]?.id,
  definition: workflow,
  agentConfigurationVersionIds: Object.fromEntries(
    parsedConfigurations.map((configuration) => [configuration.agentId, configuration.id]),
  ),
  contentHash: contentHash(workflow),
  createdAt: seededAt,
})

export async function ensureAcceptanceSeed(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      'insert into workspaces (id, record) values ($1, $2::jsonb) on conflict (id) do nothing',
      [workspace.id, JSON.stringify(workspace)],
    )
    for (const agent of agents) {
      await client.query(
        `insert into agents (id, workspace_id, current_configuration_version_id, record)
         values ($1, $2, $3, $4::jsonb) on conflict (id) do nothing`,
        [agent.id, workspace.id, agent.configurationVersionId, JSON.stringify(agent)],
      )
    }
    for (const configuration of parsedConfigurations) {
      await client.query(
        `insert into agent_configuration_versions (id, workspace_id, agent_id, version, record)
         values ($1, $2, $3, $4, $5::jsonb) on conflict (id) do nothing`,
        [configuration.id, configuration.workspaceId, configuration.agentId, configuration.version, JSON.stringify(configuration)],
      )
    }
    await client.query(
      `insert into workflows (id, workspace_id, current_version_id, record)
       values ($1, $2, $3, $4::jsonb) on conflict (id) do nothing`,
      [workflow.id, workspace.id, workflowVersion.id, JSON.stringify(workflow)],
    )
    await client.query(
      `insert into workflow_versions (id, workspace_id, workflow_id, version, entry_node_id, record)
       values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (id) do nothing`,
      [workflowVersion.id, workspace.id, workflow.id, workflowVersion.version, workflowVersion.entryNodeId, JSON.stringify(workflowVersion)],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
