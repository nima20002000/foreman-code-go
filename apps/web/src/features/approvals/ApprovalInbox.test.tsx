import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES } from '@graphql/contracts'

import { queryKeys } from '../../shared/api/query'
import { ApprovalInbox } from './ApprovalInbox'

const { respond, userDetail, userResponse } = vi.hoisted(() => ({ respond: vi.fn(), userDetail: vi.fn(), userResponse: vi.fn() }))
vi.mock('../../shared/api/query', async () => {
  const actual = await vi.importActual<typeof import('../../shared/api/query')>('../../shared/api/query')
  return { ...actual, useRespondToInteractionMutation: () => useMutation({ mutationFn: respond }) }
})
vi.mock('../../shared/api/userApprovals', () => ({ useUserInteractionQuery: userDetail, useUserInteractionResponse: userResponse }))

afterEach(() => cleanup())

describe('Approval Inbox', () => {
  it('shows User response choices from the signed-in browser session', async () => {
    const interaction = { ...NATIVE_INTERACTION_FIXTURES.opencode, approval: { handler: 'user' as const } }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.interactions(undefined, undefined, undefined), { items: [interaction], nextCursor: null })
    client.setQueryData(queryKeys.interaction(interaction.id), { interaction, canRespond: true })
    userDetail.mockReturnValue({ data: { interaction, canRespond: true }, isPending: false, isError: false, refetch: vi.fn() })
    userResponse.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false })
    respond.mockResolvedValue({ interaction: { ...interaction, status: 'delivery_pending' }, replayed: false })
    render(<QueryClientProvider client={client}><ApprovalInbox selectedInteractionId={interaction.id} /></QueryClientProvider>)
    expect(await screen.findByRole('button', { name: /Approve once/ })).toBeVisible()
    expect(screen.queryByLabelText('User bearer credential')).not.toBeInTheDocument()
    expect(respond).not.toHaveBeenCalled()
  })

  it('shows the configured reviewer and prevents a competing human response', async () => {
    const interaction = NATIVE_INTERACTION_FIXTURES.codex
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(queryKeys.interactions(undefined, undefined, undefined), { items: [interaction], nextCursor: null })
    client.setQueryData(queryKeys.interaction(interaction.id), { interaction, canRespond: false })
    render(<QueryClientProvider client={client}><ApprovalInbox selectedInteractionId={interaction.id} /></QueryClientProvider>)
    expect(await screen.findByText(/assigned to orchestrator; no human override is available/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Approve once/ })).not.toBeInTheDocument()
  })
})

vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return { Link: ({ children, params, search }: { children: import('react').ReactNode; params: { workspaceId: string }; search: { workflowId: string } }) =>
    React.createElement('a', { href: `/workspaces/${encodeURIComponent(params.workspaceId)}?workflowId=${encodeURIComponent(search.workflowId)}` }, children) }
})
