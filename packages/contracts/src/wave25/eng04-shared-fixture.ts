import { makeWave25Fixture } from './fixtures.js'
import { WorkflowVersionSchema, WorkflowRunSchema } from '../index.js'
import { WorkflowVersionV3Schema, WorkflowRunV3Schema } from './saved.js'
import { RepeatStartSnapshotV1Schema } from './repeatAdmission.js'

/** Synthetic contract fixture. No provider, SQL, credential or readiness claim. */
export function makeSharedV3Fixture(suffix = 'eng04-shared') {
  const f = makeWave25Fixture(suffix)
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  const version = WorkflowVersionV3Schema.parse({ ...f.version, id: `${f.version.id}-v3`, executionSemanticsVersion: 3,
    definition: { ...f.version.definition, executionSemanticsVersion: 3,
      nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }], executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 },
      repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
    } })
  const location = { runnerId: 'runner-local', rootPath: '/synthetic/project ', locationRevision: 4, identityHash: `sha256:${'a'.repeat(64)}` }
  const run = WorkflowRunV3Schema.parse({ ...f.run, workflowVersionId: version.id, executionSemanticsVersion: 3,
    executionLocation: location, authorizationPrincipalId: 'synthetic-principal' })
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const, commandId: 'eng04-shared-start-command', expectedWorkflowRevision: 7,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: 4, input: {} }
  const snapshot = RepeatStartSnapshotV1Schema.parse({ request, authorizationPrincipalId: 'synthetic-principal', executable: { version, configurations: f.configurations },
    workflow: { id: version.workflowId, workspaceId: version.workspaceId, revision: 7, currentVersionId: version.id,
      archived: false, definition: version.definition }, workspace: { id: version.workspaceId, archived: false, location }, draft: null })
  const scope = { ...f.scope, workflowVersionId: version.id, executionSemanticsVersion: 3 as const }
  return { ...f, version, run, request, snapshot, scope, location, legacyFixture: f }
}

export function makeSharedLegacyFixture() {
  const f = makeWave25Fixture('eng04-shared-legacy')
  const { executionSemanticsVersion, definition, ...base } = f.version
  const { executionSemanticsVersion: definitionSemantics, entryNodeId, ...graph } = definition
  void executionSemanticsVersion; void definitionSemantics; void entryNodeId
  const version = WorkflowVersionSchema.parse({ ...base, definition: { ...graph,
    edges: graph.edges.map(({ kind, ...edge }) => { void kind; return { ...edge, route: { outcomes: ['succeeded'] } } }),
  } })
  const { executionSemanticsVersion: runSemantics, ...runValue } = f.run
  void runSemantics
  return { version, run: WorkflowRunSchema.parse(runValue) }
}
