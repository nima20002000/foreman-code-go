import { AgentSchema, type Agent } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { WorkflowDefinitionV3Schema, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

export const ciHarness = {
  harness: 'codex' as const,
  model: 'gpt-6-luna',
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
    + `Call ci_run exactly once for suite ${suite}, scope full, with a fresh commandId, `
    + (suite === 'integration' ? 'partitions 2, ' : '')
    + 'and no commit override; this must publish your current worktree files to GitHub. '
    + 'Retain that commandId for an uncertain response and retry only that same request. '
    + 'Placement is automatic: do not supply a computer or placementOverride. '
    + 'Retain every ticketId in the ci_run partitions array, or the single ticketId when it is absent. '
    + 'Poll ci_get for EVERY ticket until ALL run.state values are passed, failed, canceled or lost. '
    + 'The first ticket is only one part; group.state can fail before the other parts finish. '
    + 'Record each ticket’s distinct observed states in order. Keep polling queued, starting or running tickets. '
    + 'Once all are terminal, read ci_get again and ci_logs_read for EVERY ticket. '
    + 'Choose one nonempty log line per ticket, reading additional pages from nextOffset if necessary. '
    + 'Report only observed facts. Your final answer must be one JSON object, without markdown: '
    + '{"ticketId":"the ci_run top-level ticketId","groupId":"run.groupId","suite":"' + suite + '",'
    + '"outcome":"group.state","repository":"run.repository","branch":"your context_get worktree branch",'
    + '"tickets":[{"ticketId":"run.id","part":null,"partition":null,"computer":{},'
    + '"commit":"run.commit","outcome":"run.state","exitCode":0,"logLine":"actual log line",'
    + '"observedStates":["queued","running","passed"]}]}. '
    + 'Include every part/partition exactly once. Copy part, partition (including weights), exitCode and computer '
    + 'from the terminal run; computer is run.computer.hostRef (not its label or plannedHostKey). '
    + 'A cloud computer has kind cloud, mainId, provider and slot; a Worker has kind device, mainId and deviceId. '
    + 'Repository is the owner/repository string from run.repository, and branch is your own worktree branch. '
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
      'ci_logs_read'],
  }))
  const graph = WorkflowDefinitionV3Schema.parse({
    ...base,
    entryNodeId: coordinator.nodeId,
    requiredAgentCount: assignments.length,
    approval: { handler: 'user' },
    executionPolicy: { maxParallelism: assignments.length - 1, maxNodeExecutions: assignments.length,
      agentActiveTimeoutMs: 4 * 60 * 60_000 },
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
