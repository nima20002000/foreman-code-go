import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { useConversationDraftStore } from '../conversationDraftStore'
import { useRunsSelectorUi } from '../../runs-selector/uiStore'
import { AgentChatTestSource, installChatSource } from './testSupport'
import { clients, installSelectedHandlers, mountSelected, summariesRoute, summary } from './sch10.testSupport'

beforeEach(() => {
  installChatSource()
  useRunsSelectorUi.getState().setOpen(null)
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useRunsSelectorUi.getState().setOpen(null)
  useConversationDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals()
})

it('keeps scheduled Run chat connected while the surrounding view refreshes', async () => {
  const fixture = installSelectedHandlers()
  server.use(http.get(summariesRoute, () => HttpResponse.json({
    items: [{ ...summary('run-a'), trigger: 'schedule' }], pageInfo: { nextCursor: null },
  })))
  const mounted = await mountSelected()
  await screen.findByText('Reply execution-run-a')
  await waitFor(() => expect(AgentChatTestSource.instances).toHaveLength(1))
  const stream = AgentChatTestSource.instances[0]!
  await mounted.refreshView()
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
  expect(stream.close).not.toHaveBeenCalled()
  expect(AgentChatTestSource.instances).toHaveLength(1)
  expect(screen.queryByText('Chat unavailable')).not.toBeInTheDocument()
  expect(screen.getByText('Reply execution-run-a')).toBeVisible()
  const updated = structuredClone(fixture.states.get('run-a')!)
  updated.revision++
  updated.messages.push({ id: 'scheduled-readback', conversationId: updated.conversation!.id,
    role: 'assistant', content: 'Scheduled conversation readback.', nativeMessageComplete: true })
  fixture.states.set('run-a', updated)
  await act(async () => stream.snapshot(updated))
  await screen.findByText('Scheduled conversation readback.')
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
  expect(AgentChatTestSource.instances).toHaveLength(1)
})
