import {
  DEFAULT_HARNESS_DEFAULTS,
  AgentStatusSchema,
  ApiErrorResponseSchema,
  ScenarioIdSchema,
  type AgentStatus,
  type Agent,
  type HarnessDefaults,
  type BrowserProfileSummary,
  type Conversation,
  type Message,
  type ResourceSummary,
  type RunnerSummary,
  type ScenarioId,
  type WorkflowDefinition,
  type WorkflowRunSummary,
  type WorkspaceDetails,
} from '@graphql/contracts'

export const MOCK_SCENARIOS = [
  'normal',
  'working',
  'waiting-browser',
  'auth-required',
  'interrupted',
  'runner-disconnected',
  'empty',
  'error',
] as const satisfies readonly ScenarioId[]

export type MockScenarioId = (typeof MOCK_SCENARIOS)[number]
export type MockFailureMode = 'none' | 'graph-save' | 'user-message' | 'all'
export const MOCK_WORKSPACE_ID = 'workspace-1' as const

export interface MockScenarioState {
  scenarioId: MockScenarioId
  failureMode: MockFailureMode
}

export interface MockFixture extends WorkspaceDetails {
  agents: AgentWithActiveRun[]
  conversations: ConversationWithAgent[]
  messages: Record<string, Message[]>
}

export type AgentWithActiveRun = Agent & { activeRunId?: string }

/** Conversation ownership is added to the shared contract by the workspace identity update. */
export type ConversationWithAgent = Conversation

const now = '2026-01-01T00:00:00.000Z'

const browserProfiles: BrowserProfileSummary[] = [
  {
    id: 'browser-github',
    name: 'GitHub',
    status: 'available',
    authRequired: false,
    resourceHolder: 'none',
    runnerId: 'runner-local',
  },
  {
    id: 'browser-website-admin',
    name: 'Website Admin',
    status: 'available',
    authRequired: false,
    resourceHolder: 'none',
    runnerId: 'runner-local',
  },
]

const resources: ResourceSummary[] = browserProfiles.map((profile) => ({
  id: profile.id,
  kind: 'browser',
  name: profile.name,
  status: profile.status,
  resourceHolder: profile.resourceHolder,
  authRequired: profile.authRequired,
}))

const runners: RunnerSummary[] = [
  {
    id: 'runner-local',
    name: 'Local Runner',
    health: { status: 'healthy', checkedAt: now },
  },
]

const agents = [
  {
    id: 'agent-operator',
    name: 'Operator',
    role: 'operator',
    description: 'Coordinates human approvals and hand-offs.',
    harnessSummary: { status: 'ready' as const, label: 'Local Runner', runnerId: 'runner-local' },
  },
  {
    id: 'agent-researcher',
    name: 'Researcher',
    role: 'researcher',
    description: 'Finds and summarizes source material.',
    harnessSummary: { status: 'ready' as const, label: 'Local Runner', runnerId: 'runner-local' },
  },
  {
    id: 'agent-developer',
    name: 'Developer',
    role: 'developer',
    description: 'Turns research into an implementation.',
    harnessSummary: { status: 'ready' as const, label: 'Local Runner', runnerId: 'runner-local' },
  },
  {
    id: 'agent-reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    description: 'Checks the implementation and evidence.',
    harnessSummary: { status: 'ready' as const, label: 'Local Runner', runnerId: 'runner-local' },
  },
]

const workflow: WorkflowDefinition = {
  id: 'workflow-content-pipeline',
  workspaceId: 'workspace-1',
  name: 'Research to review',
  description: 'A visible hand-off from research to implementation to review.',
  executionCondition: { kind: 'manual', description: 'Started by the operator.' },
  nodes: [
    { id: 'node-researcher', agentId: 'agent-researcher', name: 'Researcher', position: { x: 120, y: 160 } },
    { id: 'node-developer', agentId: 'agent-developer', name: 'Developer', position: { x: 400, y: 160 } },
    { id: 'node-reviewer', agentId: 'agent-reviewer', name: 'Reviewer', position: { x: 680, y: 160 } },
  ],
  edges: [
    { id: 'edge-researcher-developer', source: 'node-researcher', target: 'node-developer' },
    { id: 'edge-developer-reviewer', source: 'node-developer', target: 'node-reviewer' },
  ],
  version: 1,
  createdAt: now,
  updatedAt: now,
}

const conversations: ConversationWithAgent[] = [
  {
    id: 'conversation-1',
    workspaceId: 'workspace-1',
    agentId: 'agent-operator',
    title: 'Operator hand-off',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conversation-researcher',
    workspaceId: 'workspace-1',
    agentId: 'agent-researcher',
    title: 'Researcher brief',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conversation-developer',
    workspaceId: 'workspace-1',
    agentId: 'agent-developer',
    title: 'Developer implementation',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'conversation-reviewer',
    workspaceId: 'workspace-1',
    agentId: 'agent-reviewer',
    title: 'Reviewer evidence',
    status: 'open',
    createdAt: now,
    updatedAt: now,
  },
]

const history: Record<string, Message[]> = Object.fromEntries(
  conversations.map((item) => [
    item.id,
    [
      {
        id: `message-${item.agentId}-user`,
        conversationId: item.id,
        role: 'user' as const,
        content: `Prepare the ${item.title?.toLowerCase() ?? 'agent'} update.`,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: `message-${item.agentId}-assistant`,
        conversationId: item.id,
        role: 'assistant' as const,
        content: `The ${item.title?.toLowerCase() ?? 'agent'} context is ready for the next hand-off.`,
        createdAt: now,
        updatedAt: now,
      },
    ],
  ]),
)

const run: WorkflowRunSummary = {
  id: 'run-1',
  workspaceId: 'workspace-1',
  workflowId: workflow.id,
  executionCondition: workflow.executionCondition,
  executionState: 'completed',
  outcome: 'succeeded',
  authRequired: false,
  browserWait: null,
  runnerHealth: runners[0].health,
  startedAt: now,
  finishedAt: now,
}

const baseFixture: MockFixture = {
  workspace: {
    id: 'workspace-1',
    name: 'Website',
    description: 'A deterministic Phase 1 workspace fixture.',
    agentIds: agents.map((agent) => agent.id),
    workflowIds: [workflow.id],
    createdAt: now,
    updatedAt: now,
  },
  agents: agents.map((agent) => ({ ...agent, status: 'available' as const, executionState: 'available' as const })),
  workflows: [workflow],
  runs: [run],
  resources,
  browserProfiles,
  runners,
  conversations,
  messages: history,
}

let state: MockScenarioState = { scenarioId: 'normal', failureMode: 'none' }
let fixture: MockFixture = clone(baseFixture)
let harnessDefaults: HarnessDefaults = clone(DEFAULT_HARNESS_DEFAULTS)
let messageSequence = 0

function clone<T>(value: T): T {
  return structuredClone(value)
}

function scenarioStatus(status: AgentStatus): AgentStatus {
  return AgentStatusSchema.parse(status)
}

function applyScenario(next: MockScenarioId): MockFixture {
  const nextFixture = clone(baseFixture)
  const activeRun = nextFixture.runs[0]
  if (!activeRun) return nextFixture

  switch (next) {
    case 'working':
      activeRun.executionState = 'running'
      activeRun.outcome = 'pending'
      activeRun.finishedAt = undefined
      nextFixture.agents = nextFixture.agents.map((agent) =>
        agent.name === 'Researcher'
          ? { ...agent, status: scenarioStatus('working'), executionState: 'working', activeRunId: activeRun.id }
          : agent,
      )
      break
    case 'waiting-browser':
      activeRun.executionState = 'waiting'
      activeRun.outcome = 'pending'
      activeRun.browserWait = {
        reason: 'browser_profile',
        resourceHolder: 'operator',
        resourceId: 'browser-github',
        resourceName: 'GitHub',
        holderId: 'agent-operator',
        holderLabel: 'Operator',
        executionId: activeRun.id,
        executionLabel: 'Research to review',
      }
      activeRun.runnerHealth = { status: 'healthy', checkedAt: now }
      nextFixture.browserProfiles = nextFixture.browserProfiles?.map((profile) =>
        profile.name === 'GitHub'
          ? { ...profile, status: 'in_use', resourceHolder: 'operator' }
          : profile,
      )
      nextFixture.resources = nextFixture.resources.map((resource) =>
        resource.name === 'GitHub'
          ? { ...resource, status: 'in_use', resourceHolder: 'operator' }
          : resource,
      )
      nextFixture.agents = nextFixture.agents.map((agent) =>
        agent.name === 'Researcher'
          ? {
              ...agent,
              status: scenarioStatus('waiting_browser'),
              executionState: 'waiting_browser',
              activeRunId: activeRun.id,
            }
          : agent,
      )
      break
    case 'auth-required':
      activeRun.executionState = 'waiting'
      activeRun.outcome = 'pending'
      activeRun.authRequired = true
      activeRun.browserWait = {
        reason: 'auth_required',
        resourceHolder: 'operator',
        resourceId: 'browser-website-admin',
        resourceName: 'Website Admin',
        holderId: 'agent-operator',
        holderLabel: 'Operator',
        executionId: activeRun.id,
        executionLabel: 'Research to review',
      }
      nextFixture.browserProfiles = nextFixture.browserProfiles?.map((profile) =>
        profile.name === 'Website Admin'
          ? { ...profile, status: 'auth_required', authRequired: true, resourceHolder: 'operator' }
          : profile,
      )
      nextFixture.resources = nextFixture.resources.map((resource) =>
        resource.name === 'Website Admin'
          ? { ...resource, status: 'auth_required', authRequired: true, resourceHolder: 'operator' }
          : resource,
      )
      nextFixture.agents = nextFixture.agents.map((agent) =>
        agent.name === 'Operator'
          ? {
              ...agent,
              status: scenarioStatus('auth_required'),
              executionState: 'auth_required',
              activeRunId: activeRun.id,
            }
          : agent,
      )
      break
    case 'interrupted':
      activeRun.executionState = 'interrupted'
      activeRun.outcome = 'pending'
      activeRun.finishedAt = undefined
      nextFixture.agents = nextFixture.agents.map((agent) =>
        agent.name === 'Developer'
          ? { ...agent, status: scenarioStatus('interrupted'), executionState: 'interrupted', activeRunId: activeRun.id }
          : agent,
      )
      break
    case 'runner-disconnected':
      activeRun.executionState = 'running'
      activeRun.outcome = 'pending'
      activeRun.runnerHealth = { status: 'disconnected', message: 'Local Runner is disconnected.', checkedAt: now }
      nextFixture.runners = nextFixture.runners?.map((runner) =>
        runner.name === 'Local Runner'
          ? { ...runner, health: activeRun.runnerHealth }
          : runner,
      )
      nextFixture.agents = nextFixture.agents.map((agent) =>
        agent.name === 'Developer'
          ? { ...agent, status: scenarioStatus('disconnected'), executionState: 'disconnected', activeRunId: activeRun.id }
          : agent,
      )
      break
    case 'empty':
      nextFixture.workflows = []
      nextFixture.runs = []
      nextFixture.resources = []
      nextFixture.browserProfiles = []
      nextFixture.conversations = []
      nextFixture.messages = {}
      nextFixture.workspace.workflowIds = []
      break
    case 'error':
    case 'normal':
      break
  }
  return nextFixture
}

export function isMockScenario(value: string): value is MockScenarioId {
  return (MOCK_SCENARIOS as readonly string[]).includes(value)
}

export function getMockScenarioState(): MockScenarioState {
  return { ...state }
}

/** API serialization keeps the agent identity required by the shared contract. */
export function serializeConversation(value: ConversationWithAgent): Conversation {
  return value
}

/** API serialization keeps the current active run identity from the shared contract. */
export function serializeAgent(value: AgentWithActiveRun): Agent {
  return value
}

export function isKnownWorkspaceId(workspaceId: string): workspaceId is typeof MOCK_WORKSPACE_ID {
  return workspaceId === MOCK_WORKSPACE_ID
}

export function getMockFixture(workspaceId: string = MOCK_WORKSPACE_ID): MockFixture | undefined {
  if (!isKnownWorkspaceId(workspaceId)) return undefined
  return clone(fixture)
}

export function setMockScenario(
  scenarioId: MockScenarioId,
  failureMode: MockFailureMode = 'none',
): MockScenarioState {
  state = { scenarioId, failureMode }
  fixture = applyScenario(scenarioId)
  messageSequence = 0
  return getMockScenarioState()
}

export function resetMockFixtures(): void {
  fixture = applyScenario(state.scenarioId)
  messageSequence = 0
}

export function setMockFailureMode(failureMode: MockFailureMode): MockScenarioState {
  state = { ...state, failureMode }
  return getMockScenarioState()
}

export function shouldFailMutation(kind: 'graph-save' | 'user-message', explicit?: string | null): boolean {
  const mode = explicit ?? state.failureMode
  return mode === 'all' || mode === kind
}

export function updateMockWorkflow(workspaceId: string, next: WorkflowDefinition): WorkflowDefinition {
  if (!isKnownWorkspaceId(workspaceId)) throw new Error(`Unknown mock workspace: ${workspaceId}`)
  const normalized = clone(next)
  normalized.workspaceId = workspaceId
  const index = fixture.workflows.findIndex((item) => item.id === normalized.id)
  if (index < 0) fixture.workflows.push(normalized)
  else fixture.workflows[index] = normalized
  fixture.workspace.workflowIds = fixture.workflows.map((item) => item.id)
  return clone(normalized)
}

export function updateMockAgents(workspaceId: string, next: readonly Agent[]): Agent[] {
  if (!isKnownWorkspaceId(workspaceId)) throw new Error(`Unknown mock workspace: ${workspaceId}`)
  const agentsById = new Map(fixture.agents.map((agent) => [agent.id, agent]))
  for (const agent of next) agentsById.set(agent.id, clone(agent))
  fixture.agents = [...agentsById.values()]
  fixture.workspace.agentIds = fixture.agents.map((agent) => agent.id)
  return clone(fixture.agents)
}

export function getMockHarnessDefaults(): HarnessDefaults {
  return clone(harnessDefaults)
}

export function updateMockHarnessDefaults(next: HarnessDefaults): HarnessDefaults {
  harnessDefaults = clone(next)
  return getMockHarnessDefaults()
}

export function appendMockMessage(workspaceId: string, next: Omit<Message, 'id'>): Message {
  if (!isKnownWorkspaceId(workspaceId)) throw new Error(`Unknown mock workspace: ${workspaceId}`)
  const message = { ...clone(next), id: `message-user-${++messageSequence}` }
  const conversationMessages = fixture.messages[message.conversationId] ?? []
  fixture.messages[message.conversationId] = [...conversationMessages, message]
  return clone(message)
}

export function getMockMessages(conversationId: string): Message[] {
  return clone(fixture.messages[conversationId] ?? [])
}

export { ApiErrorResponseSchema, ScenarioIdSchema }
