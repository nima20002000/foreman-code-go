import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@graphql/contracts'
import { ApprovalInbox } from './ApprovalInbox'

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), response: vi.fn() }))
vi.mock('../../shared/api/query', () => ({
  useInfiniteInteractionsQuery: api.list, useInteractionQuery: api.detail, useRespondToInteractionMutation: api.response,
  useWorkspaceDetailsQuery: () => ({ data: undefined }),
}))
const interaction: DurableInteraction = { ...NATIVE_INTERACTION_FIXTURES.opencode, approval: { handler: 'user' } }
const nextPage = vi.fn(); const mutate = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockReturnValue({ data: { pages: [{ items: [], nextCursor: null, pendingCount: 117 }] }, isPending: false, isError: false, refetch: vi.fn(), fetchNextPage: nextPage })
  api.detail.mockReturnValue({ data: { interaction, canRespond: true }, isError: false, isPending: false, refetch: vi.fn() })
  api.response.mockReturnValue({ mutate, isPending: false, isError: false })
})
afterEach(cleanup)

describe('PR12 Approval Inbox', () => {
  it('passes route scope to the server and renders detail independently of empty history', () => {
    render(<ApprovalInbox workspaceId={interaction.workspaceId} workflowId={interaction.workflowId} selectedInteractionId={interaction.id} />)
    expect(api.list).toHaveBeenCalledWith({ workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, limit: 100, status: 'pending' }, true)
    expect(screen.getByText('Request details')).toBeTruthy()
    expect(screen.getByText('117 pending')).toBeTruthy()
    expect(screen.getByText('No pending requests')).toBeTruthy()
  })
  it('refuses a cross-scope detail and never exposes its response controls', () => {
    render(<ApprovalInbox workspaceId="other-workspace" selectedInteractionId={interaction.id} />)
    expect(screen.getByText(/outside the selected Inbox scope/)).toBeTruthy()
    expect(screen.queryByText('Request details')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull()
  })
  it('shows direct detail errors rather than falling back to a stale list entry', () => {
    api.list.mockReturnValue({ data: { pages: [{ items: [interaction], nextCursor: null }] }, isPending: false, isError: false })
    api.detail.mockReturnValue({ data: { interaction }, isError: true, isPending: false, error: new Error('Access expired'), refetch: vi.fn() })
    render(<ApprovalInbox selectedInteractionId={interaction.id} />)
    expect(screen.getByText('Request unavailable')).toBeTruthy()
    expect(screen.queryByText('Request details')).toBeNull()
  })
  it.each(['operator', 'orchestrator'] as const)('keeps %s monitoring read-only', (handler) => {
    api.detail.mockReturnValue({ data: { interaction: { ...interaction, approval: { handler, ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'o' } : {}) } }, canRespond: false }, isError: false, isPending: false })
    render(<ApprovalInbox selectedInteractionId={interaction.id} />)
    expect(screen.getByText(/Read-only monitoring/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull()
  })
  it.each(['failed', 'uncertain'] as const)('recovers %s delivery using only the selected choice', async (deliveryState) => {
    const optionId = interaction.responseOptions[0]!.optionId
    api.detail.mockReturnValue({ data: { interaction: { ...interaction, status: deliveryState === 'failed' ? 'delivery_failed' : 'delivery_pending', deliveryState, selectedOptionId: optionId }, canRespond: true }, isError: false, isPending: false })
    render(<ApprovalInbox selectedInteractionId={interaction.id} />)
    await userEvent.setup().click(screen.getByRole('button', { name: deliveryState === 'failed' ? 'Retry selected response' : 'Reconcile delivery' }))
    expect(mutate.mock.calls[0]![0]).toEqual({ interactionId: interaction.id, optionId, expectedRevision: interaction.revision })
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull()
  })
  it('does not offer recovery for a canceled interaction', () => {
    api.detail.mockReturnValue({ data: { interaction: { ...interaction, status: 'canceled', deliveryState: 'failed', selectedOptionId: interaction.responseOptions[0]!.optionId }, canRespond: true }, isError: false, isPending: false })
    render(<ApprovalInbox selectedInteractionId={interaction.id} />)
    expect(screen.queryByText('Delivery recovery')).toBeNull()
  })
  it('loads the next server page rather than treating 100 records as the whole queue', async () => {
    api.list.mockReturnValue({ data: { pages: [{ items: [], nextCursor: 'cursor', pendingCount: 120 }] }, hasNextPage: true, isPending: false, isError: false, fetchNextPage: nextPage })
    render(<ApprovalInbox />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more requests' }))
    expect(nextPage).toHaveBeenCalledTimes(1)
  })
})

vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return { Link: ({ children, params, search }: { children: import('react').ReactNode; params: { workspaceId: string }; search: { workflowId: string } }) =>
    React.createElement('a', { href: `/workspaces/${encodeURIComponent(params.workspaceId)}?workflowId=${encodeURIComponent(search.workflowId)}` }, children) }
})
