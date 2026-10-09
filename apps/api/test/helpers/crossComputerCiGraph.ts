import { AgentSchema, type Agent } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { WorkflowDefinitionV3Schema, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

export const ciHarness = {
  harness: 'codex' as const,
  model: 'gpt-5.6-luna',
  reasoningEffort: 'medium' as const,
  serviceTier: 'standard' as const,
  // Writable Agents receive their own product-managed git worktree and branch.
  sandbox: 'workspace-write' as const,
}

export const projectSuites = {
  graphql: ['build', 'lint', 'integration'],
  demo: ['build', 'lint', 'unit'],
} as const
export type ScenarioProject = keyof typeof projectSuites
export type ScenarioSuite = (typeof projectSuites)[ScenarioProject][number]

export type ScenarioAgent = {
  nodeId: string
  agentId: string
  name: string
  suite: ScenarioSuite | null
  profile: HarnessProfileSelection
  placement?: SavedNodePlacement
}

function agentPrompt(suite: ScenarioSuite | null): string {
  if (suite === null) {
    return 'Use context_get to read your own worktree and branch, then finish successfully with a short ready message. '
      + 'The workflow will then start all CI Agents in parallel. Do not request CI or change files.'
  }
  return 'Use only Foreman Code MCP tools. Do not use shell, filesystem, network or browser tools. '
    + 'Read context_get and retain your own repository and branch. Read ci_computers_list. '
    + `Call ci_run exactly once for suite ${suite}, with a fresh commandId, `
    + 'placementOverride {"kind":"auto"}, and no commit override; this must capture your current worktree files. '
    + 'Retain that commandId for an uncertain response and retry only that same request. '
    + 'Poll ci_get on your ticket until process.phase is terminal and publication is complete. '
    + 'Do not stop just because the ticket is waiting, claimed or accepted. '
    + 'Read ci_logs_read and ci_artifacts_list, then read the summary.json artifact using ci_artifact_read. '
    + 'Report only observed facts. Your final answer must be one JSON object, without markdown: '
    + '{"ticketId":"...","executionId":"...","suite":"' + suite + '",'
    + '"computer":{"kind":"main","mainId":"..."},'
    + '"outcome":"succeeded","repository":"owner/repo","branch":"...",'
    + '"logLine":"one nonempty actual log line","summarySha256":"..."}. '
    + 'Set computer to the actual selectedComputer.target.hostRef; for a Worker it has kind device and deviceId. '
    + 'If CI fails, report its actual outcome instead of claiming success. Do not edit or commit any files.'
}

export function buildCrossComputerCiGraph(
  base: WorkflowDefinitionV3,
  assignments: readonly ScenarioAgent[],
): { graph: WorkflowDefinitionV3; agents: Agent[] } {
  const coordinator = assignments[0]
  if (!coordinator || coordinator.suite !== null || assignments.length < 2) {
    throw new Error('A CI workflow needs one entry coordinator followed by suite Agents.')
  }
  if (assignments.slice(1).some(agent => agent.suite === null)) {
    throw new Error('Only the entry coordinator may omit its suite.')
  }
  if (new Set(assignments.map(agent => agent.agentId)).size !== assignments.length
    || new Set(assignments.map(agent => agent.nodeId)).size !== assignments.length) {
    throw new Error('Every CI Agent needs a separate Agent and node identity.')
  }
  const agents = assignments.map(assignment => AgentSchema.parse({
    id: assignment.agentId,
    name: assignment.name,
    productRole: 'coder',
    harness: ciHarness.harness,
    model: ciHarness.model,
    harnessConfiguration: ciHarness,
    harnessProfileSelection: assignment.profile,
    prompt: { system: 'Complete the assigned MCP task and report observed results accurately.' },
    assignedSkills: [],
    graphqlTools: ['context_get', 'ci_computers_list', 'ci_run', 'ci_get', 'ci_cancel',
      'ci_logs_read', 'ci_artifacts_list', 'ci_artifact_read'],
  }))
  const graph = WorkflowDefinitionV3Schema.parse({
    ...base,
    entryNodeId: coordinator.nodeId,
    requiredAgentCount: assignments.length,
    approval: { handler: 'user' },
    executionPolicy: { maxParallelism: assignments.length - 1, maxNodeExecutions: assignments.length },
    nodes: assignments.map((assignment, index) => ({
      id: assignment.nodeId,
      agentId: assignment.agentId,
      name: assignment.name,
      initialPrompt: agentPrompt(assignment.suite),
      position: { x: index === 0 ? 0 : 320, y: index * 180 },
      ...(assignment.placement ? { placement: assignment.placement } : {}),
    })),
    edges: assignments.slice(1).map(assignment => ({
      id: `${coordinator.nodeId}-${assignment.nodeId}`,
      source: coordinator.nodeId,
      target: assignment.nodeId,
      kind: 'execution',
    })),
  })
  return { graph, agents }
}
