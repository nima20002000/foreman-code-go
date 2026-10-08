import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { OperatorComposer } from '../../operator-chat/OperatorComposer'
import { ConversationComposer } from '../ConversationComposer'
import { SessionControls } from './SessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'
import type { ComposerSessionControls } from './useSessionControls'

function controller(discovered = true) {
  const capabilities = unavailableSessionControls('profile')
  const state = SessionControlStateSchema.parse({
    conversationId: 'chat', revision: 4, profileKey: 'profile', desiredMode: 'plan', appliedMode: 'plan',
    defaults: {}, desired: {}, applied: {}, applicability: 'applied', nativeSessionId: 'native',
    nativeProviderVersion: 'fixture-1', nativeStatus: 'resume-required',
    compaction: null, compactions: [], busyReason: null,
    capabilities: discovered ? { ...capabilities, plan: { supported: true, reason: null },
      compact: { supported: true, reason: null } } : capabilities,
    context: { nativeSessionId: 'native', model: 'model', generation: 'connection', sequence: 1,
      source: 'codex', accuracy: 'native', usedTokens: 50000, capacityTokens: 100000,
      lifetimeTokens: 80000, cost: null, observedAt: '2026-10-08T00:00:00.000Z', stale: true },
  })
  return { state, query: { isError: false, refetch: vi.fn() }, mutation: { isPending: false, isError: false },
    change: vi.fn(async () => state), command: vi.fn(async () => true) } as unknown as ComposerSessionControls
}

afterEach(() => {
  cleanup()
  useConversationDraftStore.getState().clearAllDrafts()
})

it.each(['operator', 'agent'])('shows the saved Plan mode and recovery after reloading %s chat', role => {
  const controls = controller()
  if (role === 'operator') {
    render(<OperatorComposer conversationId="chat" sessionControls={controls} onNewChat={vi.fn()} onSubmit={vi.fn()} />)
  } else {
    render(<ConversationComposer conversationId="chat" sessionControls={controls} onSubmit={vi.fn()} />)
  }
  expect(screen.getByRole('combobox', { name: 'Conversation mode' })).toHaveValue('plan')
  expect(screen.getByRole('combobox', { name: 'Conversation mode' })).toBeEnabled()
  expect(screen.getByRole('status')).toHaveTextContent('Saved session controls. Your next message or control will resume the session.')
  fireEvent.click(screen.getByRole('button', { name: '50% context · stale' }))
  expect(screen.getByText('Last known usage. Waiting for a native update.')).toBeInTheDocument()
  expect(screen.queryByText('Send a message to discover this native session’s controls.')).not.toBeInTheDocument()
})

it('explains recovery when the existing session has no saved capabilities', () => {
  render(<ConversationComposer conversationId="chat" sessionControls={controller(false)} onSubmit={vi.fn()} />)
  expect(screen.getByRole('combobox', { name: 'Conversation mode' })).toHaveValue('plan')
  expect(screen.getByRole('combobox', { name: 'Conversation mode' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Send a message to resume this session and refresh its controls.')
})

it('clears the recovery explanation after a native update loads the session', () => {
  const controls = controller()
  const view = render(<SessionControls controls={controls} />)
  expect(screen.getByRole('status')).toBeInTheDocument()
  controls.state = { ...controls.state!, nativeStatus: 'loaded', context: { ...controls.state!.context!, stale: false } }
  view.rerender(<SessionControls controls={controls} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '50% context' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Conversation mode' })).toHaveValue('plan')
})
