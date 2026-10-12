// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { agentChatFixtures, type AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { boardHref, installBoardTestLifecycle, mountMeasuredBoard } from '../../workflow-board/eng05D.testSupport'
import { inspectionBoardFixture } from '../../workflow-board/inspect/inspectionFixtures'
import { useConversationDraftStore } from '../conversationDraftStore'
import { providerFixture } from './f7.testSupport'
import { installChatSource } from './testSupport'

installBoardTestLifecycle()
afterEach(() => useConversationDraftStore.getState().clearAllDrafts())

/** Actual Board route/editor/canvas/popover with MSW. JSDOM has no layout engine: the viewport
 * dimensions below exercise placement branches and structure, NOT real pixel visibility. */
describe('G7 T-03/T-06/T-08/RISK-01 mounted Board action area', () => {
  it.each([[1400, 812], [320, 568], [390, 844]])('keeps actions outside transcript scrolling at %ix%i', async (width, height) => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height); installChatSource()
    const viewport = Object.assign(new EventTarget(), { width, height, offsetTop: 0, offsetLeft: 0 })
    vi.stubGlobal('visualViewport', viewport)
    const fixture = await inspectionBoardFixture(`g7-${width}-${height}`), scope = fixture.runs.before.scope
    const context: AgentChatContext = { workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      workflowNodeId: fixture.first.id, agentId: fixture.first.agentId, runId: scope.runId }
    const state = agentChatFixtureFor(providerFixture('codex', agentChatFixtures.active), context)
    state.messages = state.messages.filter((message) => message.role !== 'assistant')
    const chat = createAgentChatMock(state)
    server.use(...chat.handlers.slice(1), ...fixture.mock.handlers)
    server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
      id: 'g7-board-chat-reader-writer', name: 'G7 tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
        scope: { workspaceIds: [scope.workspaceId] },
        actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
      }],
    } }))))
    const beforeRun = structuredClone(fixture.mock.runs.get(scope.runId))
    const mounted = await mountMeasuredBoard(boardHref(scope))
    const trigger = await screen.findByRole('button', { name: `Open ${fixture.first.name!} chat` })
    await userEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: `${fixture.first.name!} chat` })
    expect(dialog).toHaveAttribute('data-panel', 'chat')
    const input = await within(dialog).findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.change(input, { target: { value: 'Control input at a narrow width' } })
    const transcript = within(dialog).getByRole('region', { name: 'Agent conversation transcript' })
    const actions = within(dialog).getByRole('group', { name: 'Chat actions' })
    expect(dialog.querySelectorAll('.conversation-viewport-scroll')).toHaveLength(1)
    expect(transcript).not.toContainElement(actions)
    expect(actions.parentElement).toBe(transcript.closest('.conversation-viewport')!.parentElement)
    expect(within(transcript).getByRole('status', { name: `${fixture.first.name!} is working` })).toBeInTheDocument()
    // Native session controls (context usage and its popover) sit between Attach and Queue in the same action area.
    expect(actions).toContainElement(await within(dialog).findByLabelText('Session options'))
    for (const name of ['Attach files', 'Queue message', 'Steer', 'Interrupt and send', 'Stop chat']) {
      expect(within(actions).getByRole('button', { name })).toBeEnabled()
    }
    for (let step = 0; step < 16 && document.activeElement !== within(actions).getByRole('button', { name: 'Stop chat' }); step++) {
      await userEvent.tab()
    }
    expect(within(actions).getByRole('button', { name: 'Stop chat' })).toHaveFocus()
    // Inspecting/scrolling history must not move controls into it or dismiss the popover.
    fireEvent.scroll(transcript, { target: { scrollTop: 10 } })
    expect(within(actions).getByRole('button', { name: 'Stop chat' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: `${fixture.first.name!} chat` })).toBe(dialog)
    await waitFor(() => expect((dialog as HTMLElement).style.getPropertyValue('--agent-chat-viewport-height')).toBe(`${height}px`))
    // Synthetic visual viewport resize/pan, modelling keyboard appearance without claiming geometry.
    await act(async () => { viewport.height = 400; viewport.offsetTop = 31; viewport.dispatchEvent(new Event('resize')) })
    await waitFor(() => expect((dialog as HTMLElement).style.getPropertyValue('--agent-chat-viewport-height')).toBe('400px'))
    expect(within(actions).getByRole('button', { name: 'Stop chat' })).toHaveFocus()
    await userEvent.click(within(actions).getByRole('button', { name: 'Stop chat' }))
    await waitFor(() => expect(chat.getState(context).activeTurn).toBeNull())
    expect(chat.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(chat.calls.find((call) => call.method === 'POST')!.path).toMatch(/\/interrupt$/)
    expect(fixture.mock.runs.get(scope.runId)).toEqual(beforeRun)
    expect(fixture.mock.calls.filter((call) => call.method !== 'GET')).toEqual([])
    expect(screen.getByRole('dialog', { name: `${fixture.first.name!} chat` })).toBe(dialog)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${fixture.first.name!} chat` })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(mounted.history.location.search).toContain(`runId=${scope.runId}`)
  }, 30_000)
})
