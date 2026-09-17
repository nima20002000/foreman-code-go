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
function setup() {
  const client = new QueryClient()
  client.setQueryData(['enrollment-regression'], { protected: true })
  useConversationDraftStore.setState({ drafts: { 'draft-before-enrollment': 'Save me first' } })
  render(<QueryClientProvider client={client}><OperatorAccessSettings /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Operator enrollment token'), { target: { value: 'test-token' } })
  return client
}
describe('PR17 enrollment confirmation boundary', () => {
  it('lets Cancel preserve drafts and cache without starting any identity transition', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const client = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Enroll browser' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Unsaved work'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Cancel to save or copy'))
    expect(enrollOperator).not.toHaveBeenCalled()
    expect(beginSessionChange).not.toHaveBeenCalled()
    expect(client.getQueryData(['enrollment-regression'])).toEqual({ protected: true })
    expect(useConversationDraftStore.getState().drafts['draft-before-enrollment']).toBe('Save me first')
    client.clear()
  })
  it('still clears protected data after a confirmed but failed enrollment', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // jsdom reports navigation as unimplemented; real browsers replace the document.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(enrollOperator).mockRejectedValue(new Error('Credential rejected'))
    const client = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Enroll browser' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Enrollment failed'))
    expect(beginSessionChange).toHaveBeenCalledOnce()
    expect(enrollOperator).toHaveBeenCalledWith('test-token')
    expect(client.getQueryData(['enrollment-regression'])).toBeUndefined()
    expect(useConversationDraftStore.getState().drafts).toEqual({})
    client.clear()
  })
})
