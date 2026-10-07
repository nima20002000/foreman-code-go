import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionControlStateSchema } from '@foreman-code/contracts'
import { OperatorComposer } from '../../operator-chat/OperatorComposer'
import { ConversationComposer } from '../ConversationComposer'
import { SessionControls } from './SessionControls'
import type { ComposerSessionControls } from './useSessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'

const state = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [], busyReason: null,
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
  expect(screen.queryByText(/Native default window:/)).not.toBeInTheDocument()
  expect(screen.getByText('Automatic compaction: default')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
  await waitFor(() => expect(controls.change).toHaveBeenCalledWith({ kind: 'compact' }))
})

it('labels estimated occupancy and separates current, configured, default and lifetime values', () => {
  const controls = controller()
  controls.state = SessionControlStateSchema.parse({ ...state,
    applied: { ...state.applied, contextBudget: 100000 },
    capabilities: { ...state.capabilities, modelCapacity: 200000, nativeDefaultCapacity: 160000 },
    context: { nativeSessionId: 'native-chat', model: 'model', generation: 'runtime', sequence: 3,
      observedAt: '2026-10-06T00:00:00.000Z', source: 'claude', accuracy: 'estimated',
      usedTokens: 50000, capacityTokens: 100000, lifetimeTokens: 800000, cost: null, stale: false },
  })
  const view = render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'About 50% context' }))
  expect(screen.getByText('Estimated usage: 50,000 tokens in context / 100,000 native context window')).toBeInTheDocument()
  expect(screen.getByText('Configured budget: 100,000')).toBeInTheDocument()
  expect(screen.getByText('Model capacity: 200,000')).toBeInTheDocument()
  expect(screen.getByText('Native default window: 160,000 tokens')).toBeInTheDocument()
  expect(screen.getByText('Total processed: 800,000')).toBeInTheDocument()

  controls.state = { ...controls.state!, context: { ...controls.state!.context!, accuracy: 'native' } }
  view.rerender(<SessionControls controls={controls} />)
  expect(screen.getByRole('button', { name: '50% context' })).toBeInTheDocument()
  expect(screen.getByText('50,000 tokens in context / 100,000 native context window')).toBeInTheDocument()
  expect(screen.queryByText(/Estimated usage:/)).not.toBeInTheDocument()
})

it('closes context details with Escape and restores focus to the meter', () => {
  render(<SessionControls controls={controller()} />)
  const meter = screen.getByRole('button', { name: 'Context unknown' })
  fireEvent.click(meter)
  const close = screen.getByRole('button', { name: 'Close context details' })
  close.focus()
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByText('Current usage unknown')).not.toBeInTheDocument()
  expect(meter).toHaveFocus()
})

it('renders the shared numeric budget field and submits a plain token value', async () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: 200000,
    autoCompactBudget: { supported: true, reason: null } } }
  render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  fireEvent.click(screen.getByText('Context options for this chat'))
  const input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  fireEvent.change(input, { target: { value: '150000' } })
  fireEvent.blur(input)
  await waitFor(() => expect(controls.change).toHaveBeenCalledWith({ kind: 'preferences',
    preferences: { ...state.desired, autoCompactTokens: 150000 } }))
})

it('refreshes the budget from persisted readback and ignores an untouched blur', () => {
  const controls = controller()
  controls.state = { ...state, desired: { ...state.desired, autoCompactTokens: 150000 },
    capabilities: { ...state.capabilities, modelCapacity: 200000, autoCompactBudget: { supported: true, reason: null } } }
  const view = render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  let input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  fireEvent.change(input, { target: { value: '160000' } })
  fireEvent.blur(input)
  expect(controls.change).toHaveBeenCalledTimes(1)
  vi.mocked(controls.change).mockClear()
  controls.state = { ...controls.state!, desired: { ...state.desired, autoCompactTokens: 180000 } }
  view.rerender(<SessionControls controls={controls} />)
  input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  expect(input).toHaveValue(180000)
  fireEvent.focus(input)
  fireEvent.blur(input)
  expect(controls.change).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '180000' } })
  fireEvent.blur(input)
  expect(controls.change).not.toHaveBeenCalled()
})
