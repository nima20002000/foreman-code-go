import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enrollOperator } from '../../shared/api/client'
import { beginSessionChange } from '../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { OperatorAccessSettings } from './OperatorAccessSettings'

vi.mock('../../shared/api/client', async (original) => ({ ...await original<typeof import('../../shared/api/client')>(), enrollOperator: vi.fn() }))
vi.mock('../../shared/api/sessionBoundary', async (original) => ({ ...await original<typeof import('../../shared/api/sessionBoundary')>(), beginSessionChange: vi.fn(() => 1) }))
vi.mock('../../shared/api/protectedChatStorage', async (original) => ({ ...await original<typeof import('../../shared/api/protectedChatStorage')>(), rotateProtectedSession: vi.fn() }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); useConversationDraftStore.getState().clearAllDrafts() })
async function setup() {
  const client = new QueryClient()
  client.setQueryData(['enrollment-regression'], { protected: true })
  useConversationDraftStore.setState({ drafts: { 'draft-before-enrollment': 'Save me first' } })
  render(<QueryClientProvider client={client}><OperatorAccessSettings /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Use another token' }))
  fireEvent.change(screen.getByLabelText('App access token'), { target: { value: 'test-token' } })
  return client
}
describe('PR17 enrollment confirmation boundary', () => {
  it('lets Cancel preserve drafts and cache without starting any identity transition', async () => {
    const client = await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }))
    expect(screen.getByText(/Unsaved edits and unsent messages/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(enrollOperator).not.toHaveBeenCalled()
    expect(beginSessionChange).not.toHaveBeenCalled()
    expect(client.getQueryData(['enrollment-regression'])).toEqual({ protected: true })
    expect(useConversationDraftStore.getState().drafts['draft-before-enrollment']).toBe('Save me first')
    client.clear()
  })
  it('still clears protected data after a confirmed but failed enrollment', async () => {
    // jsdom reports navigation as unimplemented; real browsers replace the document.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(enrollOperator).mockRejectedValue(new Error('Credential rejected'))
    const client = await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Connect browser' }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect & reload' }))
    await waitFor(() => expect(enrollOperator).toHaveBeenCalledWith('test-token'))
    expect(beginSessionChange).toHaveBeenCalledOnce()
    expect(enrollOperator).toHaveBeenCalledWith('test-token')
    expect(client.getQueryData(['enrollment-regression'])).toBeUndefined()
    expect(useConversationDraftStore.getState().drafts).toEqual({})
    client.clear()
  })
})
