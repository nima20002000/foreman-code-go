// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalInboxSearchSchema, NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@graphql/contracts'
import { ApprovalInbox } from './ApprovalInbox'

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), response: vi.fn(), context: vi.fn() }))
vi.mock('../../shared/api/query', () => ({ useInfiniteInteractionsQuery: api.list, useInteractionQuery: api.detail, useRespondToInteractionMutation: api.response, useWorkspaceDetailsQuery: api.context }))
vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return { Link: ({ children, params, search }: { children: import('react').ReactNode; params: { workspaceId: string }; search: { workflowId: string } }) =>
    React.createElement('a', { href: `/workspaces/${encodeURIComponent(params.workspaceId)}?workflowId=${encodeURIComponent(search.workflowId)}` }, children) }
})
const item: DurableInteraction = { ...NATIVE_INTERACTION_FIXTURES.codex, approval: { handler: 'user' }, request: { command: ['pnpm', 'test'], cwd: '/project' } }
function queue(items: DurableInteraction[] = []) {
  return { data: { pages: [{ items, pendingCount: 117, nextCursor: null }] }, isPending: false, isError: false, refetch: vi.fn(), fetchNextPage: vi.fn(), hasNextPage: false }
}
beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockImplementation(({ status }) => queue(status === 'pending' ? [item] : []))
  api.detail.mockReturnValue({ data: { interaction: item, canRespond: true }, isPending: false, isError: false, refetch: vi.fn() })
  api.response.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false })
  api.context.mockReturnValue({ data: { workspace: { id: item.workspaceId, name: 'Product workspace' }, agents: [{ id: item.requestingAgentId, name: 'Build coder' }], workflows: [{ id: item.workflowId, name: 'Release checks' }] }, isError: false })
})
afterEach(cleanup)
describe('PR17 approval presentation', () => {
  it('defaults to server-filtered pending requests and makes the count actionable', async () => {
    const changeView = vi.fn()
    render(<ApprovalInbox workspaceId={item.workspaceId} onChangeView={changeView} />)
    const enabled = api.list.mock.calls.filter(([, active]) => active)
    expect(enabled.map(([input]) => input.status)).toEqual(['pending'])
    expect(enabled[0]![0].workspaceId).toBe(item.workspaceId)
    expect(screen.getByRole('button', { name: 'Pending' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.setup().click(screen.getByRole('button', { name: '117 pending' }))
    expect(changeView).toHaveBeenCalledWith('pending')
  })
  it('pages every eligible delivery status separately, not the first history page', async () => {
    const nextDecided = vi.fn(), nextFailed = vi.fn()
    api.list.mockImplementation(({ status }) => ({ ...queue(), hasNextPage: status === 'decided' || status === 'delivery_failed', fetchNextPage: status === 'decided' ? nextDecided : nextFailed }))
    render(<ApprovalInbox view="delivery" />)
    expect(api.list.mock.calls.filter(([, active]) => active).map(([input]) => input.status)).toEqual(['decided', 'delivery_pending', 'delivery_failed'])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more requests' }))
    expect(nextDecided).toHaveBeenCalledOnce()
    expect(nextFailed).toHaveBeenCalledOnce()
  })
  it('leads with names, operation and target while retaining exact technical details', () => {
    render(<ApprovalInbox selectedInteractionId={item.id} />)
    const detail = within(screen.getByLabelText('Selected request details'))
    expect(detail.getByText('Build coder')).toBeInTheDocument()
    expect(detail.getByRole('link', { name: 'Release checks · Open workflow' })).toHaveAttribute('href', `/workspaces/${item.workspaceId}?workflowId=${item.workflowId}`)
    expect(detail.getByText('pnpm test')).toBeInTheDocument()
    expect(detail.getByText('Target:').parentElement).toHaveTextContent('/project')
    expect(detail.getByText('Technical details').closest('details')).not.toHaveAttribute('open')
    expect(detail.getByText('Workspace ID')).toBeInTheDocument()
  })
  it('does not misdescribe a user-assigned request when the viewer lacks permission', () => {
    api.detail.mockReturnValue({ data: { interaction: item, canRespond: false }, isPending: false, isError: false })
    render(<ApprovalInbox selectedInteractionId={item.id} />)
    expect(screen.getByText(/your current access does not include permission/)).toBeInTheDocument()
    expect(screen.queryByText(/assigned to operator/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Approve once/ })).not.toBeInTheDocument()
  })
  it('exposes selected state and brings newly selected details into focus', async () => {
    function Controlled() {
      const [selected, select] = useState<string>()
      return <ApprovalInbox selectedInteractionId={selected} onSelectInteraction={select} />
    }
    render(<Controlled />)
    const trigger = screen.getByRole('button', { name: /Build coder/ })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(screen.getByLabelText('Selected request details')).toHaveFocus())
    expect(screen.getByLabelText('Selected request details').parentElement).toHaveAttribute('data-has-selection', 'true')
  })
  it('keeps URL scope and selection while safely handling an unknown view', () => {
    expect(ApprovalInboxSearchSchema.parse({ workflowId: 'w', interactionId: 'i', approvalView: 'delivery' })).toEqual({ workflowId: 'w', interactionId: 'i', approvalView: 'delivery' })
    expect(ApprovalInboxSearchSchema.parse({ workflowId: 'w', approvalView: 'not-a-view' }).approvalView).toBeUndefined()
  })
})
