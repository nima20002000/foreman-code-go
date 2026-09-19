import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OperatorContextPanel } from './OperatorContextPanel'
import { useConversationDraftStore } from '../conversations'
import { setMockFailureMode, setMockScenario } from '../../shared/mocks/scenarios'

function renderPanel(selectedAgentId?: string, onReturnToOperator?: () => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <OperatorContextPanel
        workspaceId="workspace-1"
        selectedAgentId={selectedAgentId}
        onReturnToOperator={onReturnToOperator}
      />
    </QueryClientProvider>,
  )
}

describe('OperatorContextPanel', () => {
  beforeEach(() => {
    setMockScenario('normal')
    useConversationDraftStore.setState({ drafts: {} })
  })

  afterEach(() => {
    setMockScenario('normal')
    useConversationDraftStore.setState({ drafts: {} })
  })

  it('uses the API Operator identity when no URL agent is selected', async () => {
    renderPanel()

    expect(await screen.findByRole('heading', { name: 'Operator' })).toBeVisible()
    expect(screen.getByText('operator')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'History' })).toBeVisible()
    expect(screen.getByText(/Operator hand-off context is ready/i)).toBeVisible()
  })

  it('loads the selected agent identity and its agent-owned conversation', async () => {
    renderPanel('agent-researcher')

    expect(await screen.findByRole('heading', { name: 'Researcher' })).toBeVisible()
    expect(screen.getByText('researcher')).toBeVisible()
    expect(screen.getByText(/Researcher brief context is ready/i)).toBeVisible()
    expect(screen.queryByText(/Operator hand-off context is ready/i)).not.toBeInTheDocument()
  })

  it('isolates drafts by conversation when switching agents', async () => {
    const user = userEvent.setup()
    const view = renderPanel()
    const composer = await screen.findByRole('textbox', { name: 'Message' })

    await user.type(composer, 'Operator-only draft')
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OperatorContextPanel workspaceId="workspace-1" selectedAgentId="agent-researcher" />
      </QueryClientProvider>,
    )

    const researcherComposer = await screen.findByRole('textbox', { name: 'Message' })
    expect(researcherComposer).toHaveValue('')
    await user.type(researcherComposer, 'Researcher-only draft')

    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OperatorContextPanel workspaceId="workspace-1" />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Operator-only draft')
  })

  it('appends only the successful user message and clears its draft', async () => {
    const user = userEvent.setup()
    renderPanel()
    const composer = await screen.findByRole('textbox', { name: 'Message' })

    await user.type(composer, 'A user-only follow-up')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(screen.getByText('A user-only follow-up')).toBeVisible()
    expect(screen.getAllByText('Assistant').length).toBe(1)
    expect(screen.queryByText('A user-only follow-up response')).not.toBeInTheDocument()
  })

  it('shows mutation failure and retains the draft text', async () => {
    setMockFailureMode('user-message')
    const user = userEvent.setup()
    renderPanel()
    const composer = await screen.findByRole('textbox', { name: 'Message' })

    await user.type(composer, 'Keep this after failure')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Message could not be sent')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this after failure')
  })

  it.each([
    ['waiting-browser', 'agent-researcher', 'Waiting for browser', 'Waiting for GitHub. Held by Operator. Execution: Research to review.'],
    ['auth-required', undefined, 'Authentication required', 'Authentication required Website Admin. Held by Operator. Execution: Research to review.'],
    ['interrupted', 'agent-developer', 'Interrupted', undefined],
    ['runner-disconnected', 'agent-developer', 'Runner disconnected', undefined],
  ] as const)('labels the %s condition from explicit API facts', async (scenario, agentId, label, detail) => {
    setMockScenario(scenario)
    renderPanel(agentId)

    expect(await screen.findByTestId('agent-condition-label')).toHaveTextContent(label)
    if (detail) expect(screen.getByText(detail)).toBeVisible()
  })

  it('keeps a waiting agent tied to the named browser while the API keeps Operator as holder', async () => {
    setMockScenario('waiting-browser')
    renderPanel('agent-researcher')

    expect(await screen.findByRole('heading', { name: 'Researcher' })).toBeVisible()
    expect(screen.getByText('Local Runner · ready')).toBeVisible()
    expect(screen.getByTestId('agent-condition-label')).toHaveTextContent('Waiting for browser')
    expect(screen.getByText('Waiting for GitHub. Held by Operator. Execution: Research to review.')).toBeVisible()
  })

  it('does not expose fake actions and returns through the parent callback', async () => {
    const user = userEvent.setup()
    const onReturnToOperator = vi.fn()
    renderPanel('agent-researcher', onReturnToOperator)

    await screen.findByRole('heading', { name: 'Researcher' })
    for (const label of ['Run', 'Resume', 'Login', 'Open Browser', 'Files']) {
      const button = screen.getByRole('button', { name: label })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAttribute('title', expect.stringContaining('is not available.'))
    }

    await user.click(screen.getByRole('button', { name: 'Return to Operator' }))
    expect(onReturnToOperator).toHaveBeenCalledOnce()
  })
})
