import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RepeatWorkflowVersionV1Schema,
  makeWave25Fixture,
  type RepeatGetResult,
  type RepeatMutationResult,
  type RepeatPlanV1,
  type WorkflowDefinitionV2,
} from '@graphql/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RepeatEditor } from './RepeatEditor'
import type { RepeatClient } from './client'

let testSeed = 0
function graph(): WorkflowDefinitionV2 {
  const fixture = makeWave25Fixture(`repeat-editor-${testSeed}`)
  const [entry, exit] = fixture.version.definition.nodes
  return { ...fixture.version.definition,
    executionPolicy: { ...fixture.version.definition.executionPolicy!, maxNodeExecutions: 12 },
    nodes: [entry!, { ...exit!, choice: { outcomes: [
      { outcome: 'issues', target: { kind: 'branch_end' as const } },
      { outcome: 'pass', target: { kind: 'branch_end' as const } },
    ] } }],
  }
}

function savedPlan(value: WorkflowDefinitionV2, maxOccurrences = 2): RepeatPlanV1 {
  return { contractVersion: 1, blocks: [{ id: 'review-fix', nodeIds: value.nodes.map((node) => node.id),
    entryNodeId: value.nodes[0]!.id, exitNodeId: value.nodes[1]!.id, maxOccurrences,
    repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
}

function savedReadback(value: WorkflowDefinitionV2, maxOccurrences = 2, revision = 4) {
  const fixture = makeWave25Fixture(`repeat-editor-${testSeed}`)
  const repeat = savedPlan(value, maxOccurrences)
  const version = RepeatWorkflowVersionV1Schema.parse({
    ...fixture.version,
    id: 'wv-repeat-4', executionSemanticsVersion: 3,
    definition: { ...value, executionSemanticsVersion: 3, repeat },
  })
  return { contractVersion: 1 as const, executionSemanticsVersion: 3 as const,
    workspaceId: value.workspaceId, workflowId: value.id, revision,
    currentVersionId: version.id, version }
}

function clientFor(readback: ReturnType<typeof savedReadback>, mutate = vi.fn()): RepeatClient {
  return {
    capabilities: vi.fn().mockResolvedValue({ contractVersion: 1, executionSemanticsVersion: 3, supported: false,
      authoring: { flatScopesOnly: true, nesting: false, arbitraryCycles: false, maxOccurrencesMin: 1,
        maxOccurrencesMax: 2147483647, explicitLimitExit: true, earlyExitOutcome: true },
      availability: { savedAuthoring: true, persistedReadback: true, runtimeAdmission: false, meaningfulEdit: false,
        reasons: ['NATIVE_START_NOT_READY', 'REPEAT_EDIT_INTENT_NOT_READY'] } }),
    workflowMeta: vi.fn().mockResolvedValue({ workflow: readback.version.definition, revision: readback.revision,
      currentVersionId: readback.currentVersionId, archivedAt: null }),
    workspaceMeta: vi.fn().mockResolvedValue({ workspace: { id: readback.workspaceId }, revision: 1, archivedAt: null,
      executionLocation: null, locationRevision: 3, locationValidation: { status: 'unconfigured' } }),
    get: vi.fn().mockResolvedValue(readback as RepeatGetResult),
    mutate,
    run: vi.fn(),
  } as unknown as RepeatClient
}

function renderEditor(activeRuns: number, client: RepeatClient) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const value = graph()
  render(<QueryClientProvider client={query}><RepeatEditor workspaceId={value.workspaceId} workflowId={value.id}
    graph={value} activeRuns={activeRuns} sourceAgentPins={Object.entries(makeWave25Fixture(`repeat-editor-${testSeed}`).version.agentConfigurationVersionIds)
      .map(([agentId, configurationVersionId]) => ({ agentId, configurationVersionId: String(configurationVersionId) }))} client={client} /></QueryClientProvider>)
}

describe('RepeatEditor', () => {
  beforeEach(() => { testSeed += 1; window.localStorage.clear() })
  it('uses the shared direct-save contract when the workflow is idle', async () => {
    const value = graph(), readback = savedReadback(value)
    const mutate = vi.fn(async (input) => ({ value: { workspaceId: value.workspaceId, workflowId: value.id,
      revision: 5, currentVersionId: 'wv-repeat-5', version: { ...readback.version, id: 'wv-repeat-5',
        definition: { ...readback.version.definition, repeat: (input as { repeat: RepeatPlanV1 }).repeat } } }, replayed: false }) as RepeatMutationResult)
    const client = clientFor(readback, mutate)
    renderEditor(0, client)

    const cap = await screen.findByRole('spinbutton', { name: /Maximum occurrences/ })
    fireEvent.change(cap, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save repeat' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate.mock.calls[0]![0]).toMatchObject({ workspaceId: value.workspaceId, workflowId: value.id,
      expectedRevision: 4, expectedWorkflowVersionId: 'wv-repeat-4', executionSemanticsVersion: 3,
      repeat: expect.objectContaining({ blocks: [expect.objectContaining({ maxOccurrences: 3 })] }) })
    expect(mutate.mock.calls[0]![0]).not.toHaveProperty('mode')
  })

  it('keeps Stop-and-save unavailable when the deployment capability is false', async () => {
    const value = graph(), client = clientFor(savedReadback(value))
    renderEditor(1, client)
    fireEvent.change(await screen.findByRole('spinbutton', { name: /Maximum occurrences/ }), { target: { value: '3' } })
    const action = screen.getByRole('button', { name: 'Stop current Run and save edits' })
    expect(action).toBeDisabled()
    expect(screen.getByText(/deployment has not enabled meaningful repeat edits/i)).toBeInTheDocument()
    fireEvent.click(action)
    expect(client.mutate).not.toHaveBeenCalled()
  })

  it('replays the exact retained direct-save command after an ambiguous reply', async () => {
    const value = graph(), readback = savedReadback(value)
    let first = true
    const mutate = vi.fn(async (input) => {
      if (first) { first = false; throw new ApiError({ code: 'NETWORK_ERROR', message: 'lost reply' }) }
      return { value: { workspaceId: value.workspaceId, workflowId: value.id, revision: 5, currentVersionId: 'wv-repeat-5',
        version: { ...readback.version, id: 'wv-repeat-5', definition: { ...readback.version.definition,
          repeat: (input as { repeat: RepeatPlanV1 }).repeat } } }, replayed: true } as RepeatMutationResult
    })
    renderEditor(0, clientFor(readback, mutate))
    fireEvent.change(await screen.findByRole('spinbutton', { name: /Maximum occurrences/ }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save repeat' }))
    expect(await screen.findByText(/last repeat command may have gone through/i)).toBeInTheDocument()
    const firstRequest = mutate.mock.calls[0]![0]
    fireEvent.click(screen.getByRole('button', { name: 'Check exact command' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]![0]).toEqual(firstRequest)
  })
})
