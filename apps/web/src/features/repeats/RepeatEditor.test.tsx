import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { makeWave25Fixture, type RepeatPlanV1, type WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { describe, expect, it, vi } from 'vitest'
import { RepeatEditor } from './RepeatEditor'
import type { RepeatClient } from './client'

function graph(): WorkflowDefinitionV2 {
  const fixture = makeWave25Fixture('repeat-editor')
  const [entry, exit] = fixture.version.definition.nodes
  return { ...fixture.version.definition,
    executionPolicy: { ...fixture.version.definition.executionPolicy!, maxNodeExecutions: 12 },
    nodes: [entry!, { ...exit!, choice: { outcomes: [
      { outcome: 'issues', target: { kind: 'branch_end' as const } },
      { outcome: 'pass', target: { kind: 'branch_end' as const } },
    ] } }],
  }
}

function savedPlan(value: WorkflowDefinitionV2): RepeatPlanV1 {
  return { contractVersion: 1, blocks: [{ id: 'review-fix', nodeIds: value.nodes.map((node) => node.id),
    entryNodeId: value.nodes[0]!.id, exitNodeId: value.nodes[1]!.id, maxOccurrences: 2,
    repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
}

function renderEditor(activeRuns: number, client: RepeatClient) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const value = graph()
  render(<QueryClientProvider client={query}><RepeatEditor workspaceId={value.workspaceId} workflowId={value.id}
    graph={value} activeRuns={activeRuns} client={client} /></QueryClientProvider>)
}

describe('RepeatEditor', () => {
  it('uses the explicit stop-and-save action while a Run is active', async () => {
    const value = graph(), plan = savedPlan(value)
    const client: RepeatClient = {
      authoring: vi.fn().mockResolvedValue({ plan, revision: 4, workflowVersionId: 'wv-4' }),
      save: vi.fn().mockImplementation(async (request) => ({ plan: request.plan, revision: 5, workflowVersionId: 'wv-5' })),
      run: vi.fn(),
    }
    renderEditor(1, client)
    const cap = await screen.findByRole('spinbutton', { name: /Maximum occurrences/ })
    fireEvent.change(cap, { target: { value: '3' } })
    const action = await screen.findByRole('button', { name: 'Stop current Run and save edits' })
    expect(action).toBeEnabled()
    fireEvent.click(action)
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ mode: 'stop_and_save', expectedRevision: 4 }))
  })

  it('makes unsupported nesting explicit in the editor copy', async () => {
    const client: RepeatClient = { authoring: vi.fn().mockResolvedValue({ plan: null, revision: 1, workflowVersionId: null }), save: vi.fn(), run: vi.fn() }
    renderEditor(0, client)
    expect(await screen.findByText(/Scopes cannot overlap or nest/)).toBeInTheDocument()
    expect(screen.getByText(/does not add a back-edge/)).toBeInTheDocument()
  })
})
