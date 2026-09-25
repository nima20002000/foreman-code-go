import { z } from 'zod'
import {
  AgentConfigurationVersionSchema, AcceptedWorkflowApprovalConfigurationSchema,
  WorkflowApprovalConfigurationSchema, ExecutionConditionSchema, WorkflowExecutionPolicySchema,
  HarnessWorkflowCompatibilitySchema, WorkflowChoiceSchema, RunExecutionLocationSchema,
  RunExecutionStateSchema, RunOutcomeSchema, RunInputSchema, ExecutionResultSchema,
  RunStopCauseSchema, TimestampSchema,
} from '../index.js'
import { GraphIdSchema } from './graphPrimitives.js'
import { canonicalGraphJson } from './json.js'
import { ExecutionSemanticsVersionSchema as CurrentExecutionSemanticsSchema } from './workflow.js'
export { ExecutionSemanticsVersionSchema as CurrentExecutionSemanticsSchema } from './workflow.js'

/** Extracted current topology/lifecycle rules. No old WorkflowVersion validator,
 * validation projection, complexity-selected semantics or legacy dispatch. */
export const CurrentRunScopeSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, runId: GraphIdSchema,
  workflowVersionId: GraphIdSchema, executionSemanticsVersion: CurrentExecutionSemanticsSchema,
}).strict()
const Handle = z.enum(['top', 'right', 'bottom', 'left']).nullable().optional()
export const CurrentWorkflowNodeSchema = z.object({
  id: GraphIdSchema, agentId: GraphIdSchema,
  name: z.string().trim().min(1).optional(), label: z.string().trim().min(1).optional(),
  description: z.string().optional(), initialPrompt: z.string().trim().min(1).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
  join: z.object({ mode: z.literal('all') }).strict().optional(), choice: WorkflowChoiceSchema.optional(),
}).strict().superRefine((node, context) => {
  if (!node.name && !node.label) context.addIssue({ code: 'custom', path: ['name'], message: 'a workflow node requires name or label' })
})
export const CurrentWorkflowRelationshipSchema = z.object({
  id: GraphIdSchema, source: GraphIdSchema, target: GraphIdSchema,
  sourceHandle: Handle, targetHandle: Handle, label: z.string().optional(), kind: z.enum(['execution', 'approval']),
}).strict()
/** Incomplete authoring is allowed here; immutable executable validation below
 * requires a real entry, complete approval and enough execution budget. */
export const CurrentWorkflowDefinitionBaseSchema = z.object({
  id: GraphIdSchema, workspaceId: GraphIdSchema, name: z.string().trim().min(1), description: z.string().optional(),
  executionSemanticsVersion: CurrentExecutionSemanticsSchema, entryNodeId: GraphIdSchema.nullable(),
  executionCondition: ExecutionConditionSchema, approval: WorkflowApprovalConfigurationSchema.optional(),
  requiredAgentCount: z.number().int().positive().max(10000).optional(),
  nodes: z.array(CurrentWorkflowNodeSchema).max(1000), edges: z.array(CurrentWorkflowRelationshipSchema).max(8000),
  version: z.number().int().positive().optional(), executionPolicy: WorkflowExecutionPolicySchema.optional(),
  createdAt: TimestampSchema.optional(), updatedAt: TimestampSchema.optional(),
}).strict()
export const CurrentWorkflowVersionBaseSchema = z.object({
  id: GraphIdSchema, workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  version: z.number().int().positive(), executionSemanticsVersion: CurrentExecutionSemanticsSchema,
  entryNodeId: GraphIdSchema, definition: CurrentWorkflowDefinitionBaseSchema,
  agentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  approval: AcceptedWorkflowApprovalConfigurationSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), createdAt: TimestampSchema,
}).strict()
type Version = z.infer<typeof CurrentWorkflowVersionBaseSchema>

/** Proven entry, DAG, named-routing and all-required join rules, applied to the
 * actual V3 value. There is no old-schema parse or tag replacement. */
export function validateCurrentWorkflowTopology(version: Version, context: z.RefinementCtx): void {
  const issue = (message: string, path: (string | number)[] = ['definition']) => context.addIssue({ code: 'custom', path, message })
  const graph = version.definition
  if (graph.id !== version.workflowId || graph.workspaceId !== version.workspaceId || graph.version !== version.version) issue('immutable scope/version mismatch')
  if (graph.entryNodeId !== version.entryNodeId) issue('authored and immutable entry must match', ['entryNodeId'])
  if (!graph.executionPolicy || graph.executionPolicy.maxNodeExecutions < graph.nodes.length) issue('an executable version requires a sufficient execution policy')
  if (graph.requiredAgentCount !== undefined && graph.requiredAgentCount !== graph.nodes.length) issue('requiredAgentCount does not match the topology')
  if (canonicalGraphJson(graph.approval ?? null) !== canonicalGraphJson(version.approval)) issue('definition and immutable approval assignment must match')
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  if (nodes.size !== graph.nodes.length || edges.size !== graph.edges.length) issue('node and relationship IDs must be unique')
  if (!nodes.has(version.entryNodeId)) issue('entry must reference an existing node', ['entryNodeId'])
  if (new Set(graph.nodes.map((node) => node.agentId)).size !== graph.nodes.length) issue('an Agent may occur only once in this topology')
  const execution = graph.edges.filter((edge) => edge.kind === 'execution')
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]))
  const reviewers = new Set<string>()
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target) || edge.source === edge.target) issue('relationships require distinct existing endpoints')
    if (edge.kind === 'execution') {
      if (edge.target === version.entryNodeId) issue('entry cannot have an incoming execution dependency')
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    } else {
      if (reviewers.has(edge.target)) issue('an App-routed requester has at most one reviewer')
      reviewers.add(edge.target)
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
  let processed = 0
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    processed++
    for (const target of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1
      indegree.set(target, remaining)
      if (remaining === 0) queue.push(target)
    }
  }
  if (processed !== nodes.size) issue('execution relationships must form an acyclic graph')
  const reachable = new Set<string>(), visit = [version.entryNodeId]
  for (let i = 0; i < visit.length; i++) {
    const id = visit[i]!
    if (reachable.has(id)) continue
    reachable.add(id); visit.push(...(outgoing.get(id) ?? []))
  }
  for (const edge of execution) if (!reachable.has(edge.source) && reachable.has(edge.target)) issue('an excluded component cannot supply a selected-component dependency')
  if (Object.keys(version.agentConfigurationVersionIds).length !== graph.nodes.length) issue('configuration pins must describe exactly this topology')
  for (const node of graph.nodes) {
    if (!version.agentConfigurationVersionIds[node.agentId]) issue('each Agent requires an immutable configuration pin')
    if (!node.choice) continue
    const selected = new Set<string>()
    for (const declaration of node.choice.outcomes) {
      if (declaration.target.kind === 'branch_end') continue
      const edge = edges.get(declaration.target.relationshipId)
      if (!edge || edge.kind !== 'execution' || edge.source !== node.id) issue('choice targets must be outgoing execution relationships')
      selected.add(declaration.target.relationshipId)
    }
    for (const edge of execution) if (edge.source === node.id && !selected.has(edge.id)) issue('every outgoing choice relationship requires a declared outcome')
  }
}

export function validateCurrentWorkflowConfigurations(value: { version: Version; configurations: z.infer<typeof AgentConfigurationVersionSchema>[] }, context: z.RefinementCtx): void {
  const { version, configurations } = value
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  const configs = new Map(configurations.map((configuration) => [configuration.id, configuration]))
  const nodes = version.definition.nodes
  if (configs.size !== configurations.length) fail('configuration IDs must be unique')
  if (Object.keys(version.agentConfigurationVersionIds).length !== nodes.length || configurations.length !== nodes.length) fail('configuration pins must describe exactly this topology')
  for (const node of nodes) {
    const configuration = configs.get(version.agentConfigurationVersionIds[node.agentId]!)
    if (!configuration || configuration.workspaceId !== version.workspaceId || configuration.agentId !== node.agentId || !configuration.productRole) fail('an exact scoped configuration with a pinned product role is required')
  }
  const role = (nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId)
    return node && configs.get(version.agentConfigurationVersionIds[node.agentId]!)?.productRole
  }
  const orchestrators = nodes.filter((node) => role(node.id) === 'orchestrator')
  if (!nodes.length) fail('an executable workflow needs an entry node')
  if (nodes.length === 1 && version.entryNodeId !== nodes[0]?.id) fail('a sole node starts itself')
  if (orchestrators.length ? role(version.entryNodeId) !== 'orchestrator' : role(version.entryNodeId) !== 'coder') fail('entry must use the pinned Orchestrator role when present, otherwise the Worker (coder) role')
  for (const configuration of configurations) {
    if (!HarnessWorkflowCompatibilitySchema.safeParse({ configuration: configuration.harness,
      workflowApprovalHandler: version.approval.handler, designatedOrchestrator: version.approval.handler === 'orchestrator'
        && configuration.agentId === version.approval.designatedOrchestratorAgentId }).success) fail('pinned native configuration conflicts with approval authority')
  }
  const approvals = version.definition.edges.filter((edge) => edge.kind === 'approval')
  if (version.approval.handler !== 'orchestrator') {
    if (approvals.length) fail('explicit human/Operator handling cannot contain App reviewer assignments')
    return
  }
  const entry = nodes.find((node) => node.id === version.entryNodeId)
  if (entry?.agentId !== version.approval.designatedOrchestratorAgentId || role(version.entryNodeId) !== 'orchestrator') fail('the supported initialized reviewer must be the explicit entry Orchestrator')
  for (const edge of approvals) if (edge.source !== version.entryNodeId || edge.target === version.entryNodeId) fail('independent or recursive reviewer startup is unsupported')
  for (const node of nodes) {
    const configuration = configs.get(version.agentConfigurationVersionIds[node.agentId]!)
    const nativeSelfReview = configuration?.harness.harness === 'codex'
      && configuration.harness.advanced?.approvalPolicy === 'on-request' && configuration.harness.advanced.approvalsReviewer === 'auto_review'
    if (node.id !== version.entryNodeId && !nativeSelfReview && !approvals.some((edge) => edge.target === node.id)) fail('App-routed requester requires an explicit reviewer relationship')
  }
}

/** Public current Run. Private accepted Runs require location/principal below
 * the admission boundary; redacted public reads may omit those two fields. */
export const CurrentWorkflowRunSchema = z.object({
  id: GraphIdSchema, workspaceId: GraphIdSchema, workflowId: GraphIdSchema, workflowVersionId: GraphIdSchema,
  executionSemanticsVersion: CurrentExecutionSemanticsSchema,
  executionLocation: RunExecutionLocationSchema.optional(), authorizationPrincipalId: GraphIdSchema.optional(),
  stopCause: RunStopCauseSchema.optional(), agentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  approval: AcceptedWorkflowApprovalConfigurationSchema, executionCondition: ExecutionConditionSchema,
  executionState: RunExecutionStateSchema, outcome: RunOutcomeSchema, input: RunInputSchema,
  result: ExecutionResultSchema.optional(), createdAt: TimestampSchema,
  startedAt: TimestampSchema.optional(), finishedAt: TimestampSchema.optional(),
}).strict().superRefine((run, context) => {
  const terminal = run.executionState === 'completed'
  if (terminal && (run.outcome === 'pending' || !run.result || !run.finishedAt)) context.addIssue({ code: 'custom', path: ['result'], message: 'a completed run requires a terminal outcome, result, and finishedAt' })
  if (!terminal && (run.outcome !== 'pending' || run.result || run.finishedAt)) context.addIssue({ code: 'custom', path: ['outcome'], message: 'a non-completed run must retain a pending outcome without a result or finishedAt' })
  if (run.result && run.result.outcome !== run.outcome) context.addIssue({ code: 'custom', path: ['result', 'outcome'], message: 'result.outcome must match outcome' })
})
export const AcceptedCurrentNodeResultSchema = ExecutionResultSchema.superRefine((value, context) => {
  if (value.outcome !== 'succeeded') context.addIssue({ code: 'custom', message: 'only successful results are accepted inputs' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'accepted result exceeds bounds' }) }
})
