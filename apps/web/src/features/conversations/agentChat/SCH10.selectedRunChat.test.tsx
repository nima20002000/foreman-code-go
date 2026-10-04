import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor } from '../../../shared/mocks/agentChatHandlers'
import { useConversationDraftStore } from '../conversationDraftStore'
import { useRunsSelectorUi } from '../../runs-selector/uiStore'
import { runsSelectorKeys } from '../../runs-selector/query'
import { agentChatContextKey } from './model'
import { selectedChatDraftKey } from './selectedRunChatModel'
import { AgentChatTestSource, installChatSource } from './testSupport'
import { activitiesRoute, activityPage, admitted, clients, context, deferred, envelope, execution,
  historicalState, installSelectedHandlers, mountSelected, scope, selectedRoute, snapshot, snapshotRoute,
  summariesRoute, summary } from './sch10.testSupport'

const draft = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } })
const ready = (runId: string, executionId = `execution-${runId}`) => screen.findByText(`Reply ${executionId}`)
const error = (status: number) => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Unavailable' } }, { status })

beforeEach(() => { installChatSource(); useRunsSelectorUi.getState().setOpen(null) })
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useRunsSelectorUi.getState().setOpen(null)
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear(); vi.unstubAllGlobals()
})

describe('SCH-10 historical chat and Activities (real Router/Query/client + MSW)', () => {
  it('switches transcript, draft, queue and Activities between two Runs with the same Agent', async () => {
    const source = installSelectedHandlers(), mounted = await mountSelected()
    await ready('run-a'); await screen.findByText('Run activity execution-run-a'); draft('Draft A')
    const keyA = selectedChatDraftKey(execution('run-a'), context().agentId, source.states.get('run-a')!.conversation!.id)
    expect(screen.getByTestId('agent-conversation')).toHaveAttribute('data-chat-key', keyA)
    await mounted.select('run-b'); await ready('run-b'); await screen.findByText('Run activity execution-run-b')
    expect(screen.queryByText('Reply execution-run-a')).not.toBeInTheDocument()
    expect(screen.queryByText('Run activity execution-run-a')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    draft('Only B'); await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(source.posts).toHaveLength(1))
    await screen.findByText('Only B')
    expect(source.posts[0]).toMatchObject({ runId: 'run-b', body: { executionId: 'execution-run-b', expectedConversationId: 'conversation-execution-run-b' } })
    expect(source.posts[0]!.body).not.toHaveProperty('context')
    expect(source.current.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    await mounted.select('run-a'); await ready('run-a')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft A')
    expect(screen.queryByText('Only B')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).not.toBeInTheDocument()
  })

  it('switches the active native turn together with the Run and restores it on return', async () => {
    const source = installSelectedHandlers(), a = source.states.get('run-a')!
    a.sessionState = 'active'
    a.activeTurn = { requestId: a.turns[0]!.requestId, nativeTurnId: 'native-a', startedAt: a.turns[0]!.createdAt }
    a.turns[0]!.delivery = 'accepted'; a.turns[0]!.nativeTurnId = 'native-a'
    const mounted = await mountSelected(); await ready('run-a')
    expect(screen.getByRole('button', { name: 'Stop chat' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled()
    await mounted.select('run-b'); await ready('run-b')
    expect(screen.queryByRole('button', { name: 'Stop chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
    await mounted.select('run-a'); await ready('run-a')
    expect(screen.getByRole('button', { name: 'Stop chat' })).toBeEnabled()
  })

  it('keeps a removed Agent selectable from the snapshot without reading the current workflow', async () => {
    installSelectedHandlers()
    const currentLookup = vi.fn(() => error(404))
    server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId', currentLookup))
    await mountSelected(); await ready('run-a')
    expect(screen.getByRole('combobox', { name: /^Agent$/ })).toHaveDisplayValue('Removed Coder')
    expect(currentLookup).not.toHaveBeenCalled()
    draft('Continue with removed agent')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  })

  it('does not retarget an in-flight send or let its late acknowledgement clear the other Run draft', async () => {
    const source = installSelectedHandlers(), ack = deferred<ReturnType<typeof admitted>>()
    let sent: Record<string, unknown> | undefined
    server.use(http.post(`${selectedRoute}/messages`, async ({ request }) => {
      sent = await request.json() as Record<string, unknown>
      return HttpResponse.json(await ack.promise)
    }))
    const mounted = await mountSelected(); await ready('run-a'); draft('A in flight')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sent).toBeDefined())
    const original = structuredClone(source.states.get('run-a')!)
    await mounted.select('run-b'); await ready('run-b'); draft('B remains')
    const result = admitted(original, sent as unknown as Omit<SendAgentChatMessageRequest, 'context'>)
    source.states.set('run-a', result.state)
    await act(async () => { ack.resolve(result); await ack.promise })
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('B remains')
    expect(screen.queryByText('A in flight')).not.toBeInTheDocument()
    expect(sent).toMatchObject({ executionId: 'execution-run-a', expectedConversationId: original.conversation!.id })
    await mounted.select('run-a'); await ready('run-a')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(screen.getByText('A in flight')).toBeInTheDocument()
  })

  it('reconciles a send settled after returning to the same Run without applying the old snapshot', async () => {
    const source = installSelectedHandlers(), ack = deferred<ReturnType<typeof admitted>>()
    let sent: Record<string, unknown> | undefined, postCount = 0
    server.use(http.post(`${selectedRoute}/messages`, async ({ request }) => {
      postCount++; sent = await request.json() as Record<string, unknown>
      return HttpResponse.json(await ack.promise)
    }))
    const mounted = await mountSelected(); await ready('run-a'); draft('Send once')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sent).toBeDefined())
    await mounted.select('run-b'); await ready('run-b')
    await mounted.select('run-a'); await ready('run-a')
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    const result = admitted(source.states.get('run-a')!, sent as unknown as Omit<SendAgentChatMessageRequest, 'context'>)
    source.states.set('run-a', result.state)
    await act(async () => { ack.resolve(result); await ack.promise })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(postCount).toBe(1)
    expect(await screen.findByText('Send once')).toBeInTheDocument()
  })

  it('drops a late old-Run stream and rejects another execution on the current stream', async () => {
    const source = installSelectedHandlers(), mounted = await mountSelected()
    await ready('run-a')
    await waitFor(() => expect(AgentChatTestSource.instances.length).toBeGreaterThan(0))
    const old = AgentChatTestSource.instances.at(-1)!
    await mounted.select('run-b'); await ready('run-b')
    await waitFor(() => expect(old.close).toHaveBeenCalled())
    const active = AgentChatTestSource.instances.at(-1)!
    const late = structuredClone(source.states.get('run-a')!); late.revision += 100
    late.messages[1]!.content = 'Late old Run';
    const wrong = structuredClone(source.states.get('run-b')!); wrong.revision += 200
    if (wrong.conversation!.origin.kind === 'run_execution') wrong.conversation!.origin.executionId = 'wrong-execution'
    wrong.messages[1]!.content = 'Wrong execution'
    await act(async () => { old.snapshot(late, 1); active.snapshot(wrong, 2) })
    expect(screen.queryByText('Late old Run')).not.toBeInTheDocument()
    expect(screen.queryByText('Wrong execution')).not.toBeInTheDocument()
    expect(screen.getByText('Reply execution-run-b')).toBeInTheDocument()
  })

  it('fences A -> B -> A when an old A read finishes last', async () => {
    const source = installSelectedHandlers(), slow = deferred<ReturnType<typeof envelope>>()
    let held = false
    server.use(http.get(selectedRoute, async ({ request, params }) => {
      const id = String(params.runId), hasExecution = new URL(request.url).searchParams.has('executionId')
      if (id === 'run-a' && hasExecution && !held) { held = true; return HttpResponse.json(await slow.promise) }
      return HttpResponse.json(envelope(source.states.get(id)!))
    }))
    const mounted = await mountSelected()
    await waitFor(() => expect(held).toBe(true))
    const ticket = mounted.selection().capture()
    await mounted.select('run-b'); await ready('run-b')
    await mounted.select('run-a'); await ready('run-a')
    expect(mounted.selection().isCurrent(ticket)).toBe(false)
    const late = historicalState('run-a'); late.messages[1]!.content = 'Old A response'; late.revision += 100
    await act(async () => { slow.resolve(envelope(late)); await slow.promise })
    expect(screen.queryByText('Old A response')).not.toBeInTheDocument()
    expect(screen.getByText('Reply execution-run-a')).toBeInTheDocument()
  })

  it.each(['missing', 'ephemeral'] as const)('shows a short %s-session reason and no send box, retaining stored history', async (kind) => {
    const source = installSelectedHandlers(), state = source.states.get('run-a')!
    state.sessionState = 'unavailable'; state.capabilities.resume = false
    state.availability = { canSend: false, reason: 'native_session_missing', message: kind === 'ephemeral'
      ? 'This ephemeral session was lost after restart.' : 'The native session is missing.' }
    await mountSelected(); await ready('run-a')
    expect(screen.getByText('Session unavailable')).toHaveAttribute('title', state.availability.message)
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume|start separate/i })).not.toBeInTheDocument()
    expect(source.posts).toHaveLength(0)
  })

  it('requires an explicit execution and keeps same-Run execution drafts and Activities separate', async () => {
    installSelectedHandlers()
    server.use(http.get(selectedRoute, ({ request, params }) => {
      const id = new URL(request.url).searchParams.get('executionId')
      return HttpResponse.json(id ? envelope(historicalState('run-a', id), execution('run-a', id)) : {
        kind: 'execution_selection_required', target: { ...scope, runId: params.runId, workflowNodeId: params.workflowNodeId },
        executions: [{ executionId: 'exec-one', attempt: 1 }, { executionId: 'exec-two', attempt: 2 }], hasMoreExecutions: false,
      })
    }), http.get(activitiesRoute, () => {
      const page = activityPage('run-a', 'exec-one')
      page.items.push(...activityPage('run-a', 'exec-two', 'Run activity exec-two', '2').items)
      return HttpResponse.json(page)
    }))
    await mountSelected()
    const picker = await screen.findByRole('combobox', { name: /^Execution$/ })
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await userEvent.selectOptions(picker, 'exec-one'); await ready('run-a', 'exec-one'); draft('Draft one')
    await screen.findByText('Run activity exec-one')
    expect(screen.queryByText('Run activity exec-two')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Choose execution' }))
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Execution' }), 'exec-two')
    await ready('run-a', 'exec-two'); await screen.findByText('Run activity exec-two')
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
    expect(screen.queryByText('Run activity exec-one')).not.toBeInTheDocument()
  })

  it('promotes first-send drafts to the confirmed conversation without losing text edited during the send', async () => {
    const source = installSelectedHandlers()
    source.states.set('run-a', agentChatFixtureFor(agentChatFixtures.empty, context('run-a')))
    const ack = deferred<ReturnType<typeof admitted>>(); let body: Record<string, unknown> | undefined
    server.use(http.post(`${selectedRoute}/messages`, async ({ request }) => {
      body = await request.json() as Record<string, unknown>; return HttpResponse.json(await ack.promise)
    }))
    await mountSelected(); await screen.findByRole('textbox', { name: 'Message' }); draft('First message')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(body).toBeDefined()); draft('Edited next draft')
    const result = admitted(source.states.get('run-a')!, body as unknown as Omit<SendAgentChatMessageRequest, 'context'>)
    source.states.set('run-a', result.state)
    await act(async () => { ack.resolve(result); await ack.promise })
    await waitFor(() => expect(screen.getByTestId('agent-conversation')).toHaveAttribute('data-chat-key',
      selectedChatDraftKey(execution('run-a'), context().agentId, result.state.conversation!.id)))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Edited next draft'))
    expect(body).toMatchObject({ expectedConversationId: null, executionId: 'execution-run-a' })
    expect(screen.getByText('First message')).toBeInTheDocument()
  })

  it('does not change chat, drafts, Activities or URL when a newer Run arrives', async () => {
    installSelectedHandlers(); const mounted = await mountSelected(); await ready('run-a')
    await screen.findByText('Run activity execution-run-a'); draft('Keep A')
    await userEvent.click(screen.getByRole('button', { name: /^Runs$/ }))
    await screen.findByRole('menu', { name: 'Runs' })
    const ticket = mounted.selection().capture(), href = mounted.router.history.location.href
    server.use(http.get(summariesRoute, () => HttpResponse.json({ items: [summary('run-new'), summary('run-b'), summary('run-a')], pageInfo: { nextCursor: null } })))
    await act(async () => { await mounted.client.invalidateQueries({ queryKey: runsSelectorKeys.list(scope) }) })
    await waitFor(() => expect(document.querySelector('[data-run-id="run-new"]')).toBeInTheDocument())
    expect(mounted.router.history.location.href).toBe(href)
    expect(mounted.selection().isCurrent(ticket)).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep A')
    expect(screen.getByText('Reply execution-run-a')).toBeInTheDocument()
    expect(screen.getByText('Run activity execution-run-a')).toBeInTheDocument()
  })

  it('keeps Current workflow chat behavior and restores its independent draft', async () => {
    const source = installSelectedHandlers(), mounted = await mountSelected(null)
    await screen.findByRole('textbox', { name: 'Message' }); draft('Current draft')
    await mounted.select('run-a'); await ready('run-a'); draft('History draft')
    await mounted.select(null)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Current draft'))
    expect(screen.getByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(context()))
    expect(source.posts).toHaveLength(0)
  })

  it('drops an older Activities page after switching and preserves selectedRunId when filtering', async () => {
    installSelectedHandlers()
    const pending = deferred<ReturnType<typeof activityPage>>(); let requested = false
    server.use(http.get(activitiesRoute, async ({ params, request }) => {
      const id = String(params.runId)
      if (new URL(request.url).searchParams.get('cursor') === 'older-a') { requested = true; return HttpResponse.json(await pending.promise) }
      return HttpResponse.json(activityPage(id, `execution-${id}`, `Run activity ${id}`, '2', id === 'run-a' ? 'older-a' : null))
    }))
    const mounted = await mountSelected('run-a', true)
    await screen.findByText('Run activity run-a')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activity kind' }), 'agent_work')
    expect(mounted.router.history.location.href).toContain('selectedRunId=run-a')
    expect(mounted.router.history.location.href).toContain('#chat')
    const region = screen.getByRole('region', { name: 'Activities' })
    await userEvent.click(within(region).getByRole('button', { name: 'More' }))
    await waitFor(() => expect(requested).toBe(true))
    await mounted.select('run-b'); await screen.findByText('Run activity run-b')
    await act(async () => { pending.resolve(activityPage('run-a', 'execution-run-a', 'Old Activities')); await pending.promise })
    expect(screen.queryByText('Old Activities')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Activities' })).toHaveAttribute('data-run-id', 'run-b')
  })

  it('never falls back to the current graph/chat for unavailable or denied snapshots', async () => {
    const source = installSelectedHandlers()
    server.use(http.get(snapshotRoute, ({ params }) => HttpResponse.json({ snapshot: { kind: 'unavailable', ...scope, runId: params.runId, reason: 'legacy_run' } })))
    const mounted = await mountSelected(); await screen.findByText('Snapshot unavailable')
    expect(source.reads).toHaveLength(0)
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    server.use(http.get(snapshotRoute, () => error(403)))
    await mounted.select('run-b')
    await waitFor(() => expect(screen.getAllByText('No access')).toHaveLength(2))
    expect(within(screen.getByRole('button', { name: /^Runs$/ }).parentElement!).getByText('No access')).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: 'Retry' }).parentElement!).getByText('No access')).toBeInTheDocument()
    expect(source.reads).toHaveLength(0)
  })

  it('continuing chat does not write to Run/snapshot endpoints or change the saved snapshot', async () => {
    installSelectedHandlers()
    const original = snapshot('run-a'), writes = vi.fn(() => error(400))
    server.use(http.post('*/api/management/workspaces/:workspaceId/runs/:runId/*', writes),
      http.put(snapshotRoute, writes), http.patch(snapshotRoute, writes))
    await mountSelected(); await ready('run-a'); draft('Follow up')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Follow up')
    expect(writes).not.toHaveBeenCalled()
    expect(snapshot('run-a')).toEqual(original)
  })
})
