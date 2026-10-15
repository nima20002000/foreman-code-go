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

const ciTicketId = { type: 'string', minLength: 1, 'x-foreman-reference': 'ciTicket' }
const terminalOutcome = { enum: ['passed', 'failed', 'canceled', 'lost'] }

/** The app enforces this report shape and checks that the ticket id was created by this Agent. */
export function ciReportOutputSchema(suite: ScenarioSuite) {
  return {
    type: 'object',
    required: ['ticketId', 'groupId', 'suite', 'outcome', 'repository', 'branch', 'logLine', 'observedStates'],
    properties: {
      ticketId: ciTicketId,
      groupId: { type: 'string', minLength: 1 },
      suite: { const: suite },
      outcome: terminalOutcome,
      repository: { type: 'string', minLength: 1 },
      branch: { type: 'string', minLength: 1 },
      logLine: { type: 'string', minLength: 1 },
      observedStates: { type: 'array', minItems: 1, items: { type: 'string' } },
    },
  }
}

function agentPrompt(suite: ScenarioSuite | null): string {
  if (suite === null) {
    return 'Use context_get to read your own worktree and branch, then finish successfully with a short ready message. '
      + 'The workflow will then start all CI Agents in parallel. Do not request CI or change files.'
  }
  return 'Use only Foreman Code MCP tools. Do not use shell, filesystem, network or browser tools. '
    + 'Read context_get and retain your own repository and branch. Read ci_computers_list. '
    + `Call ci_run exactly once for suite ${suite}, scope full, with a fresh commandId, `
    + 'and no commit override; this must publish your current worktree files to GitHub. '
    + 'Retain that commandId for an uncertain response and retry only that same request. '
    + 'Placement is automatic: do not supply a computer or placementOverride. '
    + 'Wait with ONE ci_get call on any ticket: waitUntil "group-terminal", waitSeconds 1800 and logTail false. '
    + 'Repeat that same call only while its wait.status is still-running; do not poll tickets one by one. '
    + 'When wait.status is settled, its partitions (or run, for a single ticket) hold every ticket’s final state. '
    + 'Record the top-level ticket’s observed state changes in order from the ci_run and ci_get results you read. '
    + 'Then read ci_logs_read for the top-level ticket and choose one nonempty line from it. '
    + 'Report only observed facts. Your final answer must be one JSON object, without markdown: '
    + '{"ticketId":"the ci_run top-level ticketId","groupId":"run.groupId","suite":"' + suite + '",'
    + '"outcome":"group.state","repository":"run.repository","branch":"your context_get worktree branch",'
    + '"logLine":"actual line from the top-level ticket log",'
    + '"observedStates":["queued","running","passed"]}. '
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
      ...(assignment.suite ? { outputSchema: ciReportOutputSchema(assignment.suite) } : {}),
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
