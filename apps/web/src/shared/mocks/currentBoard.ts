import { http, HttpResponse, type RequestHandler } from 'msw'
import { AgentConfigurationVersionSchema, AgentSchema, WorkflowRunSummarySchema, type Agent } from '@graphql/contracts'
import { BrowserAccessSessionSchema, ManagedWorkspaceSchema, GraphDraftLayoutInputSchema, RunStopInputSchema } from '@graphql/contracts/management'
import {
  CurrentManagedWorkflowSchema, CurrentWorkspaceDetailsSchema, CurrentWorkflowCreateInputSchema,
  CurrentWorkflowCapabilitiesSchema, GraphDraftV3Schema, WorkflowDefinitionV3Schema, WorkflowVersionV3Schema,
  ExecutableWorkflowV3Schema, AcceptedWorkflowRunV3Schema, GraphEditStageInputV3Schema, GraphEditReadResultV3Schema,
  GraphEditAdvanceInputV3Schema, GraphEditDiscardInputV3Schema, GraphDraftApplyV3InputSchema, GraphSaveV3InputSchema,
  RunStartV3InputSchema, RepeatGraphCurrentV3Schema, repeatGraphTopologyV3, sameWorkflowValue,
  type WorkflowDefinitionV3, type WorkflowVersionV3, type GraphDraftV3, type GraphDraftOperationV3,
  type GraphEditReadResultV3, type CurrentRunDetails, type RepeatGraphCurrentV3,
} from '@graphql/contracts/wave25'

const copy = <T,>(value: T): T => structuredClone(value)
const hash = `sha256:${'b'.repeat(64)}`
const at = '2026-09-25T00:00:00.000Z'
const pageInfo = { nextCursor: null }
const emptyIntent = (): GraphEditReadResultV3 => ({ intent: null, current: [], affectedSetChanged: false, canStop: true })
const failure = (code: string, message: string, status = 409) => HttpResponse.json({ error: { code, message } }, { status })

/** Reusable MSW-only service family for the REGISTERED current Board. Nothing in
 * this module launches a provider or proves SQL/native qualification. The default
 * capability is false. Only a test-owned factory can simulate accepted Start. */
export function createCurrentBoardMock(options: {
  workspaceId?: string; allowSimulatedStart?: boolean; agents?: Agent[];
  initialWorkflow?: WorkflowDefinitionV3; onSaved?: (graph: WorkflowDefinitionV3) => void;
} = {}) {
  const workspaceId = options.workspaceId ?? 'ws-board-current'
  const agents = (options.agents ?? Array.from({ length: 5 }, (_, i) => ({ id: `agent-current-${i}`, name: `Worker ${i + 1}`,
    productRole: 'coder' as const, configurationVersionId: `cfg-current-${i}`, harness: 'codex' as const,
    harnessConfiguration: { harness: 'codex' as const, model: 'synthetic-no-native-call', reasoningEffort: 'low' as const,
      sandbox: 'read-only' as const, serviceTier: 'standard' as const }, prompt: {}, assignedSkills: [] }))).map((agent) => AgentSchema.parse(agent))
  const configurations = agents.map((agent) => AgentConfigurationVersionSchema.parse({ id: agent.configurationVersionId,
    agentId: agent.id, workspaceId, version: 1, productRole: agent.productRole,
    harness: agent.harnessConfiguration ?? { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [], contentHash: hash, createdAt: at }))
  const catalog = agents.map((agent) => ({ agent, metadataRevision: 1, archivedAt: null }))
  const drafts = new Map<string, GraphDraftV3>(), versions = new Map<string, WorkflowVersionV3>()
  const revisions = new Map<string, number>(), workflows = new Map<string, WorkflowDefinitionV3>()
  const intents = new Map<string, GraphEditReadResultV3>(), runs = new Map<string, CurrentRunDetails>()
  const currents = new Map<string, RepeatGraphCurrentV3>()
  const receipts = new Map<string, { input: unknown; value: unknown }>()
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const controls = { start: options.allowSimulatedStart === true, deniedStart: false, deniedStop: false, deniedRead: false,
    staleStart: false, unsupportedStart: false, loseStartReply: false, loseStageReply: false, loseStopReply: false,
    notOwner: false, affectedSetChanged: false, locationRevision: 1, stopCalls: 0 }
  let nextWorkflow = 0, nextRun = 0
  const workspace = () => ({ id: workspaceId, name: 'Current Board MSW (synthetic)', agentIds: agents.map((a) => a.id), workflowIds: [...workflows.keys()], createdAt: at, updatedAt: at })
  const managedWorkspace = () => ManagedWorkspaceSchema.parse({ workspace: workspace(), revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-synthetic', rootPath: '/synthetic/board' }, locationRevision: controls.locationRevision,
    locationValidation: { status: 'ready', checkedAt: at } })
  const managed = (id: string) => CurrentManagedWorkflowSchema.parse({ workflow: workflows.get(id), revision: revisions.get(id),
    currentVersionId: drafts.get(id)?.baseWorkflowVersionId ?? null, archivedAt: null })
  const summaries = () => [...runs.values()].map(({ run, cleanupPending }) => WorkflowRunSummarySchema.parse({ id: run.id,
    workspaceId, workflowId: run.workflowId, executionCondition: run.executionCondition, executionState: run.executionState,
    outcome: run.outcome, authRequired: false, browserWait: null, runnerHealth: { status: 'healthy', checkedAt: at }, cleanupPending,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) }))
  const details = () => CurrentWorkspaceDetailsSchema.parse({ workspace: workspace(), agents, workflows: [...workflows.values()], runs: summaries(),
    resources: [], browserProfiles: [], runners: [{ id: 'runner-synthetic', name: 'Synthetic only', health: { status: 'healthy', checkedAt: at } }] })
  function install(raw: WorkflowDefinitionV3, saved = false) {
    const graph = WorkflowDefinitionV3Schema.parse(raw)
    if (graph.workspaceId !== workspaceId) throw new Error('Out-of-scope MSW fixture')
    workflows.set(graph.id, graph); revisions.set(graph.id, 1)
    const draft = GraphDraftV3Schema.parse({ id: `draft-${graph.id}`, workspaceId, workflowId: graph.id,
      revision: 0, layoutRevision: 0, baseWorkflowVersionId: null, graph, stagedAgents: [],
      sourceAgentPins: catalog.map((item) => ({ agentId: item.agent.id, metadataRevision: item.metadataRevision, configurationVersionId: item.agent.configurationVersionId })),
      updatedAt: at, updatedByPrincipalId: 'principal-current-mock' })
    drafts.set(graph.id, draft)
    if (saved) publish(draft)
    return managed(graph.id)
  }
  function apply(base: GraphDraftV3, operations: readonly GraphDraftOperationV3[]) {
    const graph = copy(base.graph)
    for (const operation of operations) {
      switch (operation.type) {
        case 'agent.attach': {
          const agent = catalog.find((item) => item.agent.id === operation.agentId)
          if (!agent || agent.metadataRevision !== operation.expectedAgentRevision || agent.agent.configurationVersionId !== operation.expectedConfigurationVersionId) throw new Error('Agent pin conflict')
          if (!graph.nodes.some((n) => n.id === operation.nodeId)) graph.nodes.push({ id: operation.nodeId, agentId: operation.agentId,
            name: operation.name ?? agent.agent.name, ...(operation.position ? { position: operation.position } : {}) })
          break
        }
        case 'node.replace_v3': {
          const index = graph.nodes.findIndex((n) => n.id === operation.node.id)
          if (index < 0) graph.nodes.push(operation.node); else graph.nodes[index] = operation.node
          break
        }
        case 'node.remove': graph.nodes = graph.nodes.filter((n) => n.id !== operation.nodeId); break
        case 'node.set_choice': graph.nodes = graph.nodes.map((node) => { if (node.id !== operation.nodeId) return node
          const next = { ...node }; if (operation.choice) next.choice = operation.choice; else delete next.choice; return next }); break
        case 'relationship.put': graph.edges = [...graph.edges.filter((e) => e.id !== operation.relationship.id), operation.relationship]; break
        case 'edge.disconnect': graph.edges = graph.edges.filter((e) => e.id !== operation.edgeId); break
        case 'nodes.reorder': graph.nodes = operation.nodeIds.map((id) => graph.nodes.find((n) => n.id === id)!); break
        case 'edges.reorder': graph.edges = operation.edgeIds.map((id) => graph.edges.find((e) => e.id === id)!); break
        case 'workflow.set_entry': graph.entryNodeId = operation.entryNodeId; break
        case 'workflow.set_repeat': if (operation.repeat === null) delete graph.repeat; else graph.repeat = operation.repeat; break
        case 'workflow.set_approval': graph.approval = operation.approval; break
        case 'workflow.set_execution_condition': graph.executionCondition = operation.executionCondition; break
        case 'workflow.set_execution_limits': graph.executionPolicy = { maxParallelism: operation.maxParallelism, maxNodeExecutions: operation.maxNodeExecutions }; break
        case 'workflow.reset_execution_limits': delete graph.executionPolicy; break
        case 'workflow.set_required_agent_count': graph.requiredAgentCount = operation.requiredAgentCount; break
        case 'workflow.reset_required_agent_count': delete graph.requiredAgentCount; break
        case 'workflow.restore_version_v3': {
          const version = versions.get(operation.versionId)
          if (!version || version.workflowId !== graph.id) throw new Error('Version not found')
          return { ...base, graph: copy(version.definition) }
        }
        default: throw new Error(`This focused MSW fixture does not implement ${operation.type}; it never silently accepts an ignored operation.`)
      }
    }
    return GraphDraftV3Schema.parse({ ...base, graph })
  }
  function publish(staged: GraphDraftV3) {
    const id = staged.workflowId, revision = staged.revision + 1
    const number = [...versions.values()].filter((v) => v.workflowId === id).length + 1
    const graph = { ...staged.graph, version: number }
    const pins = Object.fromEntries(graph.nodes.map((node) => { const config = configurations.find((c) => c.agentId === node.agentId)
      if (!config) throw new Error('Missing exact configuration'); return [node.agentId, config.id] }))
    const { version } = ExecutableWorkflowV3Schema.parse({ version: { id: `version-${id}-${number}`, workspaceId, workflowId: id,
      version: number, definition: graph, entryNodeId: graph.entryNodeId, executionSemanticsVersion: 3, approval: graph.approval,
      agentConfigurationVersionIds: pins, contentHash: hash, createdAt: at }, configurations: configurations.filter((c) => c.agentId in pins) })
    const draft = GraphDraftV3Schema.parse({ ...staged, graph: version.definition, revision, publishedRevision: revision,
      baseWorkflowVersionId: version.id, stagedAgents: [] })
    versions.set(version.id, copy(version)); drafts.set(id, draft); workflows.set(id, draft.graph)
    revisions.set(id, (revisions.get(id) ?? 0) + 1); options.onSaved?.(copy(draft.graph))
    return { draft, version, agents: catalog }
  }
  if (options.initialWorkflow) install(options.initialWorkflow, options.initialWorkflow.nodes.length > 0)
  const record = (id: string): GraphEditReadResultV3 => {
    const current = copy(intents.get(id) ?? emptyIntent())
    current.canStop = !controls.deniedStop; current.affectedSetChanged = controls.affectedSetChanged
    current.current = (current.intent?.affected ?? []).map((pin) => { const detail = runs.get(pin.runId)
      const terminal = detail?.run.executionState === 'completed', pending = detail?.cleanupPending !== false
      return { pin, terminal, settled: terminal && !pending, outcome: detail?.run.outcome ?? 'pending',
        cleanupPending: pending, nativePending: pending, interactionPending: false, reviewPending: false } })
    return GraphEditReadResultV3Schema.parse(current)
  }
  function journal<T>(key: string, input: unknown, work: () => T): { value: T; replayed: boolean } {
    const receipt = receipts.get(key)
    if (receipt) { if (!sameWorkflowValue(receipt.input, input)) throw new Error('COMMAND_CONFLICT')
      return { value: copy(receipt.value as T), replayed: true } }
    const value = work(); receipts.set(key, { input: copy(input), value: copy(value) }); return { value, replayed: false }
  }
  async function dispatch(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url), path = decodeURIComponent(url.pathname), method = request.method
    const prefix = `/api/management/workspaces/${workspaceId}`
    const publicPrefix = `/api/workspaces/${workspaceId}`
    if (!path.startsWith(prefix) && !path.startsWith(publicPrefix)) return undefined
    if (controls.deniedRead && method === 'GET') return failure('FORBIDDEN', 'Private fixture read denied', 403)
    const body: unknown = ['POST', 'PUT'].includes(method) ? await request.clone().json().catch(() => ({})) : undefined
    calls.push({ method, path, ...(body ? { body: copy(body) } : {}) })
    try {
      if (method === 'GET' && path === publicPrefix) return HttpResponse.json(details())
      if (method === 'GET' && path === `${publicPrefix}/agents`) return HttpResponse.json({ agents })
      if (method === 'GET' && path === prefix) return HttpResponse.json(managedWorkspace())
      if (method === 'GET' && path === `${prefix}/agents`) return HttpResponse.json({ items: catalog, pageInfo })
      const configMatch = path.match(/\/agents\/([^/]+)\/versions\/([^/]+)$/)
      if (method === 'GET' && configMatch) { const version = configurations.find((c) => c.agentId === configMatch[1] && c.id === configMatch[2])
        return version ? HttpResponse.json({ version }) : failure('NOT_FOUND', 'Pinned configuration not found', 404) }
      if (path === `${prefix}/workflows`) {
        if (method === 'GET') return HttpResponse.json({ items: [...workflows.keys()].map(managed), pageInfo })
        if (method === 'POST') { const input = CurrentWorkflowCreateInputSchema.parse(body)
          if (input.workspaceId !== workspaceId) return failure('SCOPE_MISMATCH', 'Out of scope')
          return HttpResponse.json(journal(`create:${input.commandId}`, input, () => install({ id: `workflow-current-${++nextWorkflow}`,
            workspaceId, name: input.name, ...(input.description ? { description: input.description } : {}), executionSemanticsVersion: 3,
            entryNodeId: null, nodes: [], edges: [], executionCondition: { kind: 'manual' }, approval: { handler: 'user' },
            executionPolicy: { maxParallelism: 4, maxNodeExecutions: 40 } })), { status: 201 }) }
      }
      const workflowMatch = path.match(/\/workflows\/([^/]+)(.*)$/)
      if (workflowMatch) {
        const id = workflowMatch[1]!, tail = workflowMatch[2]!, draft = drafts.get(id)
        if (!draft) return failure('NOT_FOUND', 'Workflow not found', 404)
        if (!tail && method === 'GET') return HttpResponse.json(path.startsWith(publicPrefix) ? { workflow: workflows.get(id) } : managed(id))
        if (method === 'GET' && tail.startsWith('/versions/')) { const version = versions.get(tail.slice('/versions/'.length))
          return version?.workflowId === id ? HttpResponse.json({ version }) : failure('NOT_FOUND', 'Version not found', 404) }
        if (method === 'GET' && tail === '/versions') return HttpResponse.json({ items: [...versions.values()].filter((v) => v.workflowId === id), pageInfo })
        if (tail === '/runs' && method === 'POST') {
          const input = RunStartV3InputSchema.parse(body)
          if (controls.deniedStart) return failure('FORBIDDEN', 'Start denied for exact workflow', 403)
          if (controls.unsupportedStart || !controls.start) return failure('EXECUTION_SEMANTICS_UNSUPPORTED', 'Synthetic runtime admission is disabled', 409)
          const response = journal(`start:${input.commandId}`, input, () => {
            if (controls.staleStart || input.expectedWorkflowRevision !== revisions.get(id) || input.expectedDraftRevision !== draft.revision
              || input.draftId !== draft.id || input.workflowVersionId !== draft.baseWorkflowVersionId
              || input.expectedLocationRevision !== controls.locationRevision) throw new Error('REVISION_CONFLICT')
            const version = versions.get(input.workflowVersionId)!
            if (!sameWorkflowValue(input.expectedAgentConfigurationVersionIds, version.agentConfigurationVersionIds)) throw new Error('CONFIGURATION_CONFLICT')
            const run = AcceptedWorkflowRunV3Schema.parse({ id: `run-current-${++nextRun}`, workspaceId, workflowId: id,
              workflowVersionId: version.id, agentConfigurationVersionIds: version.agentConfigurationVersionIds, executionSemanticsVersion: 3,
              authorizationPrincipalId: 'principal-current-mock', approval: version.approval, executionCondition: version.definition.executionCondition,
              executionLocation: { runnerId: 'runner-synthetic', rootPath: '/synthetic/board', locationRevision: controls.locationRevision, identityHash: hash },
              input: input.input, executionState: 'queued', outcome: 'pending', createdAt: at })
            runs.set(run.id, { run, executions: [], activity: [], cleanupPending: false })
            currents.set(run.id, RepeatGraphCurrentV3Schema.parse({ kind: 'current', protocolVersion: 1,
              scope: { workspaceId, workflowId: id, runId: run.id, workflowVersionId: version.id, executionSemanticsVersion: 3 },
              topology: repeatGraphTopologyV3(version), asOfSequence: '0', retentionFloor: '0', historyCoverage: 'from_admission',
              state: { run: { executionState: 'queued', outcome: 'pending', stopRequested: false }, occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [] } }))
            return { run, accepted: true as const }
          })
          if (controls.loseStartReply) { controls.loseStartReply = false; return HttpResponse.error() }
          return HttpResponse.json({ ...response.value, replayed: response.replayed })
        }
        const draftTail = tail === '/drafts' ? '' : tail.startsWith(`/drafts/${draft.id}`) ? tail.slice(`/drafts/${draft.id}`.length) : undefined
        if (draftTail !== undefined) {
          if (!draftTail && (method === 'GET' || method === 'POST')) return HttpResponse.json(draft)
          if (draftTail === '/layout' && method === 'PUT') {
            const input = GraphDraftLayoutInputSchema.parse(body)
            return HttpResponse.json(journal(`layout:${input.commandId}`, input, () => {
              if (input.expectedLayoutRevision !== (draft.layoutRevision ?? 0)) throw new Error('LAYOUT_REVISION_CONFLICT')
              const node = draft.graph.nodes.find((n) => n.id === input.nodeId)
              if (!node) throw new Error('NODE_NOT_FOUND')
              node.position = input.position; draft.layoutRevision = input.expectedLayoutRevision + 1
              return { draftId: draft.id, layoutRevision: draft.layoutRevision, nodeId: input.nodeId, position: input.position }
            }))
          }
          if (draftTail === '/operations' && method === 'POST') {
            const input = GraphDraftApplyV3InputSchema.parse(body)
            return HttpResponse.json(journal(`apply:${input.commandId}`, input, () => {
              if (input.expectedRevision !== draft.revision) throw new Error('REVISION_CONFLICT')
              const next = { ...apply(draft, input.operations), revision: draft.revision + 1 }; drafts.set(id, next)
              return { draft: next, agents: catalog, effects: [], previousDraft: draft }
            }))
          }
          if (draftTail === '/save' && method === 'POST') {
            const input = GraphSaveV3InputSchema.parse(body)
            return HttpResponse.json(journal(`save:${input.commandId}`, input, () => {
              if (input.expectedRevision !== draft.revision) throw new Error('REVISION_CONFLICT')
              return publish(draft)
            }))
          }
          if (draftTail.startsWith('/edit-intents')) {
            if (method === 'GET') return HttpResponse.json(record(id))
            if (draftTail === '/edit-intents' && method === 'POST') {
              const input = GraphEditStageInputV3Schema.parse(body)
              const response = journal(`stage:${input.commandId}`, input, () => {
                if (input.expectedRevision !== draft.revision || input.expectedWorkflowVersionId !== draft.baseWorkflowVersionId) throw new Error('REVISION_CONFLICT')
                const stagedDraft = apply(draft, input.operations)
                const affected = [...runs.values()].filter((r) => r.run.executionState !== 'completed' || r.cleanupPending).map(({ run }) => ({
                  workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: run.workflowVersionId,
                  executionSemanticsVersion: 3 as const, agentConfigurationVersionIds: run.agentConfigurationVersionIds }))
                const intentId = `intent-${input.commandId}`
                const intent = { id: intentId, ownerPrincipalId: 'principal-current-mock', workspaceId, workflowId: id, draftId: draft.id,
                  stageCommandId: input.commandId, stageInputHash: hash, expectedRevision: input.expectedRevision,
                  expectedWorkflowVersionId: input.expectedWorkflowVersionId, savedWorkflowRevision: revisions.get(id)!, stagedDraft, agentPins: [], affected,
                  advanceCommandId: `advance-${input.commandId}`, advanceInputHash: hash, discardCommandId: `discard-${input.commandId}`, discardInputHash: hash,
                  stops: affected.map((pin) => ({ input: { workspaceId, runId: pin.runId, commandId: `stop-${intentId}-${pin.runId}` }, inputHash: hash })),
                  saveInput: { workspaceId, workflowId: id, draftId: draft.id, commandId: `save-${input.commandId}`, executionSemanticsVersion: 3 as const, expectedRevision: draft.revision },
                  saveInputHash: hash, state: 'staged' as const, saveAttempted: false, createdAt: at, updatedAt: at }
                intents.set(id, GraphEditReadResultV3Schema.parse({ ...emptyIntent(), intent })); return record(id)
              })
              if (controls.loseStageReply) { controls.loseStageReply = false; return HttpResponse.error() }
              return HttpResponse.json(response.replayed ? record(id) : response.value)
            }
            if (draftTail.endsWith('/advance') && method === 'POST') {
              const input = GraphEditAdvanceInputV3Schema.parse(body), read = record(id), intent = read.intent
              if (!intent || input.intentId !== intent.id || input.commandId !== intent.advanceCommandId) return failure('INTENT_CONFLICT', 'Wrong exact intent')
              if (intent.state === 'saved') return HttpResponse.json(read)
              if (read.affectedSetChanged || !read.canStop && read.current.some((r) => !r.settled)) return failure('FORBIDDEN', 'Affected runs cannot be stopped', 403)
              if (read.current.some((r) => !r.settled)) {
                if (!['waiting', 'stopping'].includes(intent.state)) controls.stopCalls += intent.stops.length
                intent.state = 'waiting'; for (const pin of intent.affected) { const detail = runs.get(pin.runId)
                  if (detail) detail.cleanupPending = true; markStop(pin.runId) }
              } else { intent.result = publish(intent.stagedDraft); intent.saveAttempted = true; intent.state = 'saved' }
              intents.set(id, read); return HttpResponse.json(record(id))
            }
            if (draftTail.endsWith('/discard') && method === 'POST') {
              const input = GraphEditDiscardInputV3Schema.parse(body), read = record(id)
              if (!read.intent || input.intentId !== read.intent.id || input.commandId !== read.intent.discardCommandId) return failure('INTENT_CONFLICT', 'Wrong exact intent')
              if (read.intent.state === 'saved') return failure('ALREADY_SAVED', 'Cannot discard a saved version')
              read.intent.state = 'discarded'; intents.set(id, read); return HttpResponse.json(record(id))
            }
          }
        }
      }
      if (path === `${prefix}/runs` && method === 'GET') return HttpResponse.json({ items: [...runs.values()].map((r) => r.run).filter((run) => run.workflowId === url.searchParams.get('workflowId')), pageInfo })
      const match = path.match(/\/runs\/([^/]+)(.*)$/)
      if (match) {
        const runId = match[1]!, tail = match[2]!, detail = runs.get(runId)
        if (!detail) return failure('NOT_FOUND', 'Run not found', 404)
        if (!tail && method === 'GET') return HttpResponse.json(detail)
        if (tail.includes('/graph') && tail.endsWith('/current') && method === 'GET') return HttpResponse.json(currents.get(runId))
        if (tail === '/events' && method === 'GET') return HttpResponse.json({ items: [], pageInfo })
        if (tail === '/stop' && method === 'POST') {
          const input = RunStopInputSchema.parse(body)
          if (controls.deniedStop) return failure('FORBIDDEN', 'Stop denied', 403)
          const response = journal(`stop:${input.commandId}`, input, () => {
            controls.stopCalls++
            if (!controls.notOwner && detail.run.executionState !== 'completed') { detail.cleanupPending = true; markStop(runId) }
            return { runId, status: controls.notOwner ? 'not_owner' as const : detail.run.executionState === 'completed' ? 'already_terminal' as const : 'accepted' as const, processStopped: false }
          })
          if (controls.loseStopReply) { controls.loseStopReply = false; return HttpResponse.error() }
          return HttpResponse.json({ ...response.value, replayed: response.replayed })
        }
      }
      return undefined
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_INPUT'
      return failure(code.length < 100 ? code : 'INVALID_INPUT', 'Current V3 mock rejected the exact request; no fallback occurred.')
    }
  }
  const capabilities = () => CurrentWorkflowCapabilitiesSchema.parse({ contractVersion: 1, executionSemanticsVersion: 3, supported: controls.start,
    authoring: { flatScopesOnly: true, nesting: false, arbitraryCycles: false, maxOccurrencesMin: 1, maxOccurrencesMax: 2147483647, explicitLimitExit: true, earlyExitOutcome: true },
    availability: { savedAuthoring: true, persistedReadback: true, meaningfulEdit: true, runtimeAdmission: controls.start,
      reasons: controls.start ? [] : ['NATIVE_START_NOT_READY'] } })
  const handlers: RequestHandler[] = [
    http.get('/api/auth/session', () => HttpResponse.json(BrowserAccessSessionSchema.parse({ principal: {
      id: 'principal-current-mock', name: 'Synthetic current Board', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
        actions: ['workspaces:read', 'workflows:read', 'workflows:create', 'agents:read', 'graph:read', 'graph:edit', 'graph:save', 'interactions:read', 'runs:read',
          ...(!controls.deniedStart ? ['runs:start'] : []), ...(!controls.deniedStop ? ['runs:stop'] : [])], scope: { workspaceIds: [workspaceId] },
      }] }, account: { name: 'Synthetic current Board', email: 'current-board@example.test' } }))),
    http.get('/api/management/repeats/capabilities', () => HttpResponse.json(capabilities())),
    http.get('/api/workspaces', () => HttpResponse.json({ workspaces: [workspace()] })),
    http.get('/api/management/workspaces', () => HttpResponse.json({ items: [managedWorkspace()], pageInfo })),
    http.all(new RegExp(`/api/(?:management/)?workspaces/${workspaceId}(?:/|$)`), ({ request }) => dispatch(request)),
  ]
  function markStop(runId: string) {
    const current = currents.get(runId)
    if (current && !current.state.run.stopRequested) {
      current.state.run.stopRequested = true
      current.asOfSequence = String(BigInt(current.asOfSequence) + 1n)
    }
  }
  function settle(runId: string, cleanup = false) { const detail = runs.get(runId), current = currents.get(runId)
    if (!detail || !current) throw new Error('Run not found')
    detail.run = { ...detail.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: at }; detail.cleanupPending = cleanup
    current.state.run = { executionState: 'completed', outcome: 'canceled', stopRequested: true, cleanupPending: cleanup, unsettledReviewCount: 0, pendingInteractionCount: 0 }
    current.asOfSequence = String(BigInt(current.asOfSequence) + 1n)
  }
  return { workspaceId, agents, configurations, workflows, drafts, versions, runs, currents, calls, controls, receipts,
    handlers, dispatch, install, details, managed, catalog, capabilities, settle, record }
}
