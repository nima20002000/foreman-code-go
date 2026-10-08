import { describe, expect, it } from 'vitest'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { fixture } from '../graph/nextDraft/core.cases'
import { savedPlacementFixture as placement } from '../node-placement/fixtures'
import { boardStartPins, type BoardStartPreflight } from './startPreflight'

function savedFacts(placed: boolean) {
  const context = fixture()
  const graph = context.draft.graph
  if (placed) graph.nodes = graph.nodes.map(node => ({ ...node, placement }))
  const mock = createCurrentBoardMock({ workspaceId: graph.workspaceId, initialWorkflow: graph,
    allowSimulatedStart: true, agents: context.agents.map(({ agent }) => ({ ...agent,
      harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex })) })
  const workflow = mock.managed(graph.id)
  const displayed = mock.drafts.get(graph.id)!
  const facts: BoardStartPreflight = {
    workflow,
    workspace: ManagedWorkspaceSchema.parse({ workspace: { id: graph.workspaceId, name: 'Workspace',
      agentIds: [], workflowIds: [graph.id] }, revision: 1, archivedAt: null, locationRevision: 1,
      executionLocation: { runnerId: 'main', rootPath: '/unavailable' },
      locationValidation: { status: 'ready', checkedAt: '2026-10-01T00:00:00Z' } }),
    capabilities: mock.capabilities(),
    version: mock.versions.get(workflow.currentVersionId!)!,
  }
  facts.workspace.locationValidation = { status: 'unavailable', checkedAt: '2026-10-01T00:00:00Z',
    error: { code: 'DIRECTORY_UNAVAILABLE', message: 'The directory is unavailable.' } }
  return { displayed, facts }
}

describe('Board start location checks', () => {
  it('allows saved agent placements when the original workspace directory is unavailable', () => {
    const { displayed, facts } = savedFacts(true)
    expect(boardStartPins(displayed, facts)).toMatchObject({ workflowVersionId: facts.version!.id,
      expectedLocationRevision: facts.workspace.locationRevision })
  })

  it('requires the workspace directory for agents using ordinary Main execution', () => {
    const { displayed, facts } = savedFacts(false)
    expect(() => boardStartPins(displayed, facts)).toThrow('execution folder is unavailable')
  })

  it('requires the workspace directory when a placed workflow contains a job', () => {
    const { displayed, facts } = savedFacts(true)
    const job = { kind: 'job' as const, id: 'job-node', name: 'Build', jobDefinitionId: 'job-definition',
      jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version' }
    displayed.graph.nodes.push(job)
    facts.version!.definition.nodes.push(job)
    facts.workflow.workflow.nodes.push(job)
    expect(() => boardStartPins(displayed, facts)).toThrow('execution folder is unavailable')
  })

  it.each(['restricted', 'unconfigured'] as const)('keeps the %s workspace selection blocked even with placements', status => {
    const { displayed, facts } = savedFacts(true)
    facts.workspace.locationValidation = { status }
    facts.workspace.executionLocation = null
    expect(() => boardStartPins(displayed, facts)).toThrow('execution folder is unavailable')
  })
})
