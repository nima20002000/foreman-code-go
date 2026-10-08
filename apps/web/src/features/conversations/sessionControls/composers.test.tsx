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
  function mount(sendDisabled = false) {
    const controls = controller()
    const send = vi.fn()
    const attachment = <button type="button">Ready attachment</button>
    if (role === 'Operator') render(<OperatorComposer conversationId="chat" sessionControls={controls}
      onNewChat={vi.fn()} onSubmit={send} attachmentControl={attachment} hasAttachments sendDisabled={sendDisabled} />)
    else render(<ConversationComposer conversationId="chat" sessionControls={controls}
      onSubmit={send} attachmentControl={attachment} hasAttachments sendDisabled={sendDisabled} />)
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
  it('submits a Plan task from the send button after Tab completion', () => {
    const { controls, send, input } = mount()
    fireEvent.change(input, { target: { value: '/p' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('/plan')
    expect(controls.command).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '/plan Inspect files' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('/plan Inspect files', 'plan')
    expect(controls.command).not.toHaveBeenCalled()
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
  it.each(['/plan', '/plan off', '/compact'])('routes %s from the send button only to controls', async content => {
    const { controls, send, input } = mount(true)
    fireEvent.change(input, { target: { value: content } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(controls.command).toHaveBeenCalledExactlyOnceWith(content, 'chat'))
    expect(send).not.toHaveBeenCalled()
  })
  it.each(['/plan', '/compact'])('autocompletes %s while ordinary messages are blocked', async content => {
    const { controls, send, input } = mount(true)
    fireEvent.change(input, { target: { value: content.slice(0, 2) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(controls.command).toHaveBeenCalledExactlyOnceWith(content, 'chat'))
    expect(send).not.toHaveBeenCalled()
  })
  it.each(['ctrlKey', 'altKey', 'metaKey', 'shiftKey'])('does not submit autocomplete on %s + Enter', modifier => {
    const { controls, send, input } = mount()
    fireEvent.change(input, { target: { value: '/p' } })
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true })
    expect(input).toHaveValue('/p')
    expect(controls.command).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('leaves Shift + Tab to backward focus navigation', () => {
    const { controls, input } = mount()
    fireEvent.change(input, { target: { value: '/p' } })
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(input).toHaveValue('/p')
    expect(controls.command).not.toHaveBeenCalled()
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

it('saves the edited budget as defaults without a competing blur write', () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: 200000,
    autoCompactBudget: { supported: true, reason: null } } }
  render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  const input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  fireEvent.change(input, { target: { value: '150000' } })
  const save = screen.getByRole('button', { name: 'Save as default for future chats' })
  fireEvent.mouseDown(save)
  fireEvent.blur(input, { relatedTarget: save })
  fireEvent.click(save)
  expect(controls.change).toHaveBeenCalledExactlyOnceWith({ kind: 'save-default',
    preferences: { ...state.desired, autoCompactTokens: 150000 } })
})

it('keeps an unsaved budget through polling and resets it when the chat changes', () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: 200000,
    autoCompactBudget: { supported: true, reason: null } } }
  const view = render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' }), { target: { value: '150000' } })
  controls.state = { ...controls.state!, revision: 2, desired: { ...state.desired, autoCompactTokens: 180000 } }
  view.rerender(<SessionControls controls={controls} />)
  expect(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })).toHaveValue(150000)
  controls.state = { ...controls.state!, conversationId: 'other-chat', desired: { ...state.desired, autoCompactTokens: 190000 } }
  view.rerender(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  expect(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })).toHaveValue(190000)
})

it('resets an unsaved budget when switching nodes before either conversation exists', () => {
  const controls = Object.assign(controller(), { scope: 'first-node' })
  controls.state = { ...state, conversationId: null,
    capabilities: { ...state.capabilities, modelCapacity: 200000,
      autoCompactBudget: { supported: true, reason: null } } }
  const view = render(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' }), {
    target: { value: '150000' },
  })
  controls.scope = 'second-node'
  view.rerender(<SessionControls controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Context unknown' }))
  expect(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })).toHaveValue(null)
  fireEvent.click(screen.getByRole('button', { name: 'Save as default for future chats' }))
  expect(controls.change).toHaveBeenCalledExactlyOnceWith({ kind: 'save-default', preferences: state.desired })
})

it('keeps the Operator composer to one toolbar in reading order with notes on their own line', () => {
  const controls = controller()
  controls.state = { ...state, desiredMode: 'plan', appliedMode: 'regular',
    context: { nativeSessionId: 'native-chat', model: 'model', generation: 'runtime', sequence: 3,
      observedAt: '2026-10-06T00:00:00.000Z', source: 'codex', accuracy: 'native',
      usedTokens: 25000, capacityTokens: 100000, lifetimeTokens: null, cost: null, stale: false } }
  render(<OperatorComposer conversationId="chat" sessionControls={controls} onNewChat={vi.fn()} onSubmit={vi.fn()}
    attachmentControl={<button type="button">Attach files</button>} context={<button type="button">Agent settings: model</button>} />)
  const toolbar = screen.getByRole('button', { name: 'Send message' }).parentElement!
  const order = Array.from(toolbar.querySelectorAll('button, select')).map(element =>
    element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '')
  expect(order).toEqual(['Attach files', 'Agent settings: model', 'RegularPlan', '25% context', 'Send message'])
  expect(screen.getByRole('combobox', { name: 'Conversation mode' })).toHaveValue('plan')
  const meter = screen.getByRole('button', { name: '25% context' })
  expect(meter).toHaveTextContent('25%')
  expect(meter).not.toHaveTextContent('context')
  const note = screen.getByText('Plan mode starts on the next turn.')
  expect(note.closest('.session-controls-status')).not.toBeNull()
})
