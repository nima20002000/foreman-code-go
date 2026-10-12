import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentChatTestSource, installChatSource, mountChat } from './testSupport'
import { server } from '../../../mocks/server'

const clients: ReturnType<typeof mountChat>['client'][] = []
beforeEach(installChatSource)
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useConversationDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals()
})

it.each([
  ['interrupting', 'Stop requested—execution not yet confirmed stopped.'],
  ['uncertain', 'Delivery uncertain—may still be running.'],
  ['waiting_approval', 'Waiting for approval'],
] as const)('visibly explains Board chat %s even when sending is unavailable', async (phase, label) => {
  const state: AgentChatState = structuredClone(agentChatFixtures.active)
  state.sessionState = phase
  state.availability = { canSend: false, reason: 'harness_unavailable', message: 'Native delivery not confirmed' }
  const mounted = mountChat(state)
  clients.push(mounted.client)
  await mounted.ready()
  expect(screen.getByText(label)).toBeVisible()
  const availability = screen.getByText('Messaging paused').closest('details')!
  fireEvent.click(within(availability).getByText('Messaging paused'))
  expect(within(availability).getByText('Native delivery not confirmed')).toBeVisible()
})

it('keeps readable chat quiet while polling is available', async () => {
  const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(mounted.client)
  await mounted.ready()
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  const stream = AgentChatTestSource.instances[0]!
  act(() => stream.open())
  act(() => stream.fail())
  expect(screen.queryByText('Connecting to activity updates.')).not.toBeInTheDocument()
  expect(screen.getByText('It is a workflow engine.', { selector: '.conversation-message-content' })).toBeVisible()
})

it('shows the Board chat command error inline', async () => {
  const mounted = mountChat(agentChatFixtures.idleAfterCompletion)
  clients.push(mounted.client)
  await mounted.ready()
  server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', () => HttpResponse.json({
    error: { code: 'HARNESS_UNAVAILABLE', message: 'The selected computer is disconnected.' },
  }, { status: 503 })))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'A follow-up' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(await screen.findByText('The selected computer is disconnected.')).toBeVisible()
})
