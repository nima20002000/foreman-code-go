import { z } from 'zod'
import {
  AgentConfigurationVersionSchema, AcceptedWorkflowApprovalConfigurationSchema,
  ExecutionResultSchema, HarnessWorkflowCompatibilitySchema, RunInputSchema, IdSchema, TimestampSchema, WorkflowDefinitionSchema,
  WorkflowEdgeSchema, WorkflowNodeSchema, WorkflowVersionSchema, WorkflowRunSchema,
} from '../index.js'
import { canonicalGraphJson } from './json.js'

export const EXECUTION_SEMANTICS_VERSION = 2 as const
/** This is deliberately not an environment toggle. Qualification changes the admission boundary later. */
export const WAVE25_ADMISSION_ENABLED = false as const
export const ExecutionSemanticsVersionSchema = z.union([z.literal(1), z.literal(2)])
export const ChoiceOutcomeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
export const ChoiceTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edge'), relationshipId: IdSchema }).strict(),
  z.object({ kind: z.literal('branch_end') }).strict(),
])
export const WorkflowChoiceSchema = z.object({
  outcomes: z.array(z.object({ outcome: ChoiceOutcomeSchema, target: ChoiceTargetSchema }).strict()).min(1).max(16),
}).strict().superRefine((value, context) => {
  const outcomes = new Set<string>()
  for (const [index, declaration] of value.outcomes.entries()) {
    if (outcomes.has(declaration.outcome)) context.addIssue({ code: 'custom', path: ['outcomes', index], message: 'outcomes must be unique' })
    outcomes.add(declaration.outcome)
  }
})
export type WorkflowChoice = z.infer<typeof WorkflowChoiceSchema>

export const WorkflowNodeV2Schema = z.object({
  ...WorkflowNodeSchema.shape,
  join: z.object({ mode: z.literal('all') }).strict().optional(),
  choice: WorkflowChoiceSchema.optional(),
}).strict().superRefine((node, context) => {
  if (!node.name && !node.label) context.addIssue({ code: 'custom', path: ['name'], message: 'a workflow node requires name or label' })
})
const relationshipShape = WorkflowEdgeSchema.omit({ route: true }).shape
export const WorkflowExecutionRelationshipSchema = z.object({
  ...relationshipShape, kind: z.literal('execution'),
}).strict()
export const WorkflowApprovalRelationshipSchema = z.object({
  ...relationshipShape, kind: z.literal('approval'),
}).strict()
export const WorkflowRelationshipSchema = z.discriminatedUnion('kind', [
  WorkflowExecutionRelationshipSchema, WorkflowApprovalRelationshipSchema,
])
export type WorkflowRelationship = z.infer<typeof WorkflowRelationshipSchema>

/** Editable v2 records can be incomplete; executable acceptance below is separate. */
export const WorkflowDefinitionV2Schema = WorkflowDefinitionSchema.extend({
  executionSemanticsVersion: z.literal(2), entryNodeId: IdSchema.nullable(),
  nodes: z.array(WorkflowNodeV2Schema).max(1000),
  edges: z.array(WorkflowRelationshipSchema).max(8000),
}).strict()
export type WorkflowDefinitionV2 = z.infer<typeof WorkflowDefinitionV2Schema>
export const WorkflowVersionV2Schema = z.object({
  ...WorkflowVersionSchema.shape,
  executionSemanticsVersion: z.literal(2),
  definition: WorkflowDefinitionV2Schema,
  approval: AcceptedWorkflowApprovalConfigurationSchema,
}).strict().superRefine((version, context) => {
  const issue = (message: string, path: (string | number)[] = ['definition']) => context.addIssue({ code: 'custom', path, message })
  const graph = version.definition
  const ids = [version.id, version.workspaceId, version.workflowId, version.entryNodeId,
    ...graph.nodes.flatMap((node) => [node.id, node.agentId]), ...graph.edges.map((edge) => edge.id),
    ...Object.values(version.agentConfigurationVersionIds)]
  if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))) issue('v2 identities must be bounded opaque graph IDs')
  if (graph.id !== version.workflowId || graph.workspaceId !== version.workspaceId || graph.version !== version.version) issue('immutable scope/version mismatch')
  if (graph.entryNodeId !== version.entryNodeId) issue('authored and immutable entry must match', ['entryNodeId'])
  if (!graph.executionPolicy || graph.executionPolicy.maxNodeExecutions < graph.nodes.length) issue('an executable version requires a sufficient execution policy')
  if (graph.requiredAgentCount !== undefined && graph.requiredAgentCount !== graph.nodes.length) issue('requiredAgentCount does not match the topology')
  if (canonicalGraphJson(graph.approval ?? null) !== canonicalGraphJson(version.approval)) issue('definition and immutable approval assignment must match')
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  if (nodes.size !== graph.nodes.length || edges.size !== graph.edges.length) issue('node and relationship IDs must be unique')
  if (!nodes.has(version.entryNodeId)) issue('entry must reference an existing node', ['entryNodeId'])
  // The existing domain binds one logical Agent/session per node in a one-shot Run.
  if (new Set(graph.nodes.map((node) => node.agentId)).size !== graph.nodes.length) issue('an Agent may occur only once in this one-shot topology')
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
  const reachable = new Set<string>()
  const visit = [version.entryNodeId]
  for (let i = 0; i < visit.length; i++) {
    const id = visit[i]!
    if (reachable.has(id)) continue
    reachable.add(id)
    visit.push(...(outgoing.get(id) ?? []))
  }
  for (const edge of execution) if (!reachable.has(edge.source) && reachable.has(edge.target)) issue('an excluded component cannot supply a selected-component dependency')
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
})
export type WorkflowVersionV2 = z.infer<typeof WorkflowVersionV2Schema>

/** Validates actual immutable configuration records, never mutable labels or display roles. */
export const ExecutableWorkflowV2Schema = z.object({
  version: WorkflowVersionV2Schema,
  configurations: z.array(AgentConfigurationVersionSchema).max(1000),
}).strict().superRefine(({ version, configurations }, context) => {
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
    if (!HarnessWorkflowCompatibilitySchema.safeParse({
      configuration: configuration.harness, workflowApprovalHandler: version.approval.handler,
      designatedOrchestrator: version.approval.handler === 'orchestrator' && configuration.agentId === version.approval.designatedOrchestratorAgentId,
    }).success) fail('pinned native configuration conflicts with approval authority')
  }
  const approvals = version.definition.edges.filter((edge) => edge.kind === 'approval')
  if (version.approval.handler !== 'orchestrator') {
    if (approvals.length) fail('explicit human/Operator handling cannot contain App reviewer assignments')
    return
  }
  const entry = nodes.find((node) => node.id === version.entryNodeId)
  if (entry?.agentId !== version.approval.designatedOrchestratorAgentId || role(version.entryNodeId) !== 'orchestrator') fail('the supported initialized reviewer must be the explicit entry Orchestrator')
  for (const edge of approvals) {
    if (edge.source !== version.entryNodeId || edge.target === version.entryNodeId) fail('independent or recursive reviewer startup is unsupported')
  }
  for (const node of nodes) {
    if (node.id !== version.entryNodeId && !approvals.some((edge) => edge.target === node.id)) fail('App-routed requester requires an explicit reviewer relationship')
  }
})

export const CompatibleWorkflowDefinitionSchema = z.union([WorkflowDefinitionSchema, WorkflowDefinitionV2Schema])
export const CompatibleWorkflowVersionSchema = z.union([WorkflowVersionSchema, WorkflowVersionV2Schema])
// safeExtend preserves the legacy Run lifecycle refinements while adding only the new-mode pin.
export const WorkflowRunV2Schema = WorkflowRunSchema.safeExtend({ executionSemanticsVersion: z.literal(2) })
export const CompatibleWorkflowRunSchema = z.union([WorkflowRunSchema, WorkflowRunV2Schema])

export const ChoiceResultEnvelopeSchema = z.object({
  routing: z.object({ outcome: ChoiceOutcomeSchema }).strict(),
  data: z.json(),
}).strict().superRefine((value, context) => {
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'accepted result envelope exceeds bounded JSON limits' }) }
})
export type ChoiceResultEnvelope = z.infer<typeof ChoiceResultEnvelopeSchema>
/** Accept only an entire JSON value. No trimming Markdown, searching prose, or fallback. */
export function parseChoiceResultEnvelope(result: unknown, choice: WorkflowChoice): ChoiceResultEnvelope {
  canonicalGraphJson(result, 128 * 1024) // bound the complete tree before recursive JSON/schema validation
  const accepted = ExecutionResultSchema.parse(result)
  if (accepted.outcome !== 'succeeded') throw new Error('CHOICE_RESULT_NOT_SUCCESSFUL')
  let output: unknown = accepted.output
  if (typeof output === 'string') {
    if (new TextEncoder().encode(output).byteLength > 64 * 1024) throw new Error('CHOICE_RESULT_TOO_LARGE')
    output = JSON.parse(output)
  }
  canonicalGraphJson(output, 64 * 1024)
  const envelope = ChoiceResultEnvelopeSchema.parse(output)
  const declaration = WorkflowChoiceSchema.parse(choice)
  if (!declaration.outcomes.some((item) => item.outcome === envelope.routing.outcome)) throw new Error('CHOICE_OUTCOME_UNDECLARED')
  return envelope
}

export function assertWave25Admission(): never {
  throw new Error('EXECUTION_SEMANTICS_ROLLOUT_DISABLED')
}
// Keep these pins distinct from the graph wire schema version.
export const WorkflowSemanticsPinSchema = z.object({
  workflowVersionId: IdSchema, executionSemanticsVersion: ExecutionSemanticsVersionSchema,
  acceptedAt: TimestampSchema,
}).strict()

/** Private execution inputs/results; these values never cross the graph feed. */
export const AcceptedNodeResultV2Schema = ExecutionResultSchema.superRefine((value, context) => {
  if (value.outcome !== 'succeeded') context.addIssue({ code: 'custom', message: 'only successful results are accepted inputs' })
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'accepted result exceeds bounds' }) }
})
export const RunNodeInputV2Schema = z.object({
  executionSemanticsVersion: z.literal(2), runInput: RunInputSchema,
  predecessors: z.array(z.object({
    relationshipId: IdSchema, senderNodeId: IdSchema, senderExecutionId: IdSchema,
    acceptedResult: AcceptedNodeResultV2Schema,
  }).strict()).max(8000),
}).strict().superRefine((value, context) => {
  const ids = value.predecessors.map((predecessor) => predecessor.relationshipId)
  const ordered = [...ids].sort()
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== ordered[index])) context.addIssue({ code: 'custom', message: 'predecessors are unique and sorted by relationship ID, never canvas order' })
  try { canonicalGraphJson(value, 4 * 1024 * 1024) } catch { context.addIssue({ code: 'custom', message: 'private node input exceeds bounds' }) }
})
export type RunNodeInputV2 = z.infer<typeof RunNodeInputV2Schema>
