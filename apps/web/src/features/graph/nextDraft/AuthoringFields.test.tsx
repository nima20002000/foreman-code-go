import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkflowDefinitionV2 } from '@graphql/contracts/wave25'
import { ApprovalFields, ChoiceFields, EntryFields, NodeFields, RelationshipFields } from './AuthoringFields'
import { fixture } from './core.cases'
import { putRelationship } from './model'

function Form({ revision = 7 }: { revision?: number }) {
  const context = fixture(['orchestrator', 'coder'])
  context.draft.revision = revision
  const [graph, setGraph] = useState(context.draft.graph)
  return <><EntryFields graph={graph} context={context} change={setGraph} />
    <NodeFields graph={graph} node={graph.nodes.find((node) => node.id === 'node-0')!} context={context} change={setGraph} />
    <output data-testid="entry">{graph.entryNodeId}</output><output data-testid="order">{graph.nodes.map((node) => node.id).join(',')}</output></>
}

describe('Agent 6 accessible authoring forms (not browser performance evidence)', () => {
  it('entry control is keyboard focusable and reorder never changes entry', async () => {
    const user = userEvent.setup()
    render(<Form />)
    await user.tab()
    expect(screen.getByLabelText('Entry node')).toHaveFocus()
    screen.getByRole('button', { name: 'Move later' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('order')).toHaveTextContent('node-1,node-0')
    expect(screen.getByTestId('entry')).toHaveTextContent('node-0')
  })
  it('name and instruction forms retain typing across revision-only rerenders', async () => {
    const user = userEvent.setup(), view = render(<Form />)
    await user.clear(screen.getByLabelText('Node name'))
    await user.type(screen.getByLabelText('Node name'), 'Unsaved name')
    await user.type(screen.getByLabelText('Node instruction'), 'Keep this form')
    view.rerender(<Form revision={8} />)
    expect(screen.getByLabelText('Node name')).toHaveValue('Unsaved name')
    expect(screen.getByLabelText('Node instruction')).toHaveValue('Keep this form')
    expect(screen.getByLabelText('Node instruction')).toHaveFocus()
  })
  it('choice creation leaves an unresolved target until explicit branch-end selection', async () => {
    const user = userEvent.setup()
    function ChoiceForm() {
      const [graph, setGraph] = useState(fixture().draft.graph)
      return <><ChoiceFields graph={graph} node={graph.nodes[0]!} change={setGraph} /><output data-testid="choice">{JSON.stringify(graph.nodes[0]!.choice)}</output></>
    }
    render(<ChoiceForm />)
    await user.selectOptions(screen.getByLabelText('Routing mode'), 'choice')
    await user.click(screen.getByRole('button', { name: 'Add outcome' }))
    expect(screen.getByLabelText('Target for outcome 1')).toHaveValue('edge:')
    await user.type(screen.getByLabelText('Outcome 1'), 'finished')
    await user.selectOptions(screen.getByLabelText('Target for outcome 1'), 'end')
    expect(screen.getByTestId('choice')).toHaveTextContent('branch_end')
    expect(screen.getByText(/No prose, Markdown/)).toBeInTheDocument()
  })
  it('form action deletes only the chosen semantic record', async () => {
    const user = userEvent.setup(), report = vi.fn()
    function Relationships() {
      const [graph, setGraph] = useState<WorkflowDefinitionV2>(() => putRelationship(fixture().draft.graph,
        { id: 'approval', source: 'node-0', target: 'node-1', kind: 'approval' }))
      const relationship = graph.edges.find((edge) => edge.id === 'approval')
      return <>{relationship ? <RelationshipFields graph={graph} relationship={relationship} change={setGraph} report={report} /> : null}
        <output data-testid="relationships">{graph.edges.map((edge) => edge.id).join(',')}</output></>
    }
    render(<Relationships />)
    await user.click(screen.getByRole('button', { name: 'Remove this approval record' }))
    expect(screen.getByTestId('relationships')).toHaveTextContent('execution-1')
    expect(screen.getByTestId('relationships')).not.toHaveTextContent('approval')
    expect(report).not.toHaveBeenCalled()
  })
  it('switching to Human cannot silently prune existing App assignments', async () => {
    const user = userEvent.setup(), report = vi.fn(), context = fixture(['orchestrator', 'coder'])
    let graph = putRelationship(context.draft.graph, { id: 'approval', source: 'node-0', target: 'node-1', kind: 'approval' })
    graph = { ...graph, approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-0' } }
    const change = vi.fn((update: (value: WorkflowDefinitionV2) => WorkflowDefinitionV2) => { graph = update(graph) })
    render(<ApprovalFields graph={graph} context={context} change={change} report={report} />)
    await user.selectOptions(screen.getByLabelText('Approval handler'), 'user')
    expect(report).toHaveBeenCalledOnce()
    expect(graph.edges.map((edge) => edge.id)).toEqual(['execution-1', 'approval'])
    expect(graph.approval!.handler).toBe('orchestrator')
  })
})
