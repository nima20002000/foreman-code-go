import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionControlStateSchema } from '@graphql/contracts'
import { OperatorComposer } from '../../operator-chat/OperatorComposer'
import { ConversationComposer } from '../ConversationComposer'
import { SessionControls } from './SessionControls'
import type { ComposerSessionControls } from './useSessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'

const state = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, compaction: null, busyReason: null,
  capabilities: { profileKey: 'profile', model: 'model', modelCapacity: null, contextBudgets: [], contextProfiles: [],
    compact: { supported: true, reason: null }, plan: { supported: true, reason: null },
    autoCompact: { supported: true, reason: null }, autoCompactBudget: { supported: false, reason: 'Capacity unknown' } } })
function controller() {
  return { state, query: { isError: false, refetch: vi.fn() }, mutation: { isPending: false, isError: false },
    change: vi.fn(async () => state), command: vi.fn(async () => true) } as unknown as ComposerSessionControls
}
afterEach(() => { cleanup(); useConversationDraftStore.getState().clearAllDrafts() })
for (const role of ['Operator', 'node'] as const) describe(`${role} composer native commands`, () => {
  function mount() {
    const controls = controller()
    const send = vi.fn()
    const attachment = <button type="button">Ready attachment</button>
    if (role === 'Operator') render(<OperatorComposer conversationId="chat" sessionControls={controls}
      onNewChat={vi.fn()} onSubmit={send} attachmentControl={attachment} hasAttachments />)
    else render(<ConversationComposer conversationId="chat" sessionControls={controls}
      onSubmit={send} attachmentControl={attachment} hasAttachments />)
    return { controls, send, input: screen.getByRole('textbox', { name: 'Message' }) }
  }
  it('uses a native operation for bare commands and keeps attachments outside message submission', async () => {
    const { controls, send, input } = mount()
    fireEvent.change(input, { target: { value: '/compact' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(controls.command).toHaveBeenCalledWith('/compact', 'chat'))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Ready attachment' })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '/plan off' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(controls.command).toHaveBeenCalledWith('/plan off', 'chat'))
  })
  it('submits one Plan task through normal admission and ignores slash text elsewhere', () => {
    const { send, input } = mount()
    fireEvent.change(input, { target: { value: '/plan Inspect the repository' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('/plan Inspect the repository', 'plan')
    fireEvent.change(input, { target: { value: 'Explain /compact' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenLastCalledWith('Explain /compact')
  })
  it('preserves the draft on command failure and does not submit while composing IME input', async () => {
    const { controls, send, input } = mount()
    vi.mocked(controls.command).mockRejectedValue(new Error('Compaction is unconfirmed.'))
    fireEvent.change(input, { target: { value: '/compact' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(controls.command).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Compaction is unconfirmed.')
    expect(input).toHaveValue('/compact')
    expect(send).not.toHaveBeenCalled()
  })
})
it('shows unknown context honestly and the popover invokes the compact operation', async () => {
  const controls = controller()
  render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  expect(screen.getByText('Current usage unknown')).toBeInTheDocument()
  expect(screen.getByText('Automatic compaction: default')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
  await waitFor(() => expect(controls.change).toHaveBeenCalledWith({ kind: 'compact' }))
})
