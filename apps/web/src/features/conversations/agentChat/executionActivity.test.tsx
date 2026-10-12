import { fireEvent, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentChatFixtures, type AgentChatExecutionActivityPage, type AgentChatExecutionItem, type AgentChatState,
} from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { useConversationDraftStore } from '../conversationDraftStore'
import { mergeExecutionActivity } from './executionActivity'
import { installChatSource, mountChat } from './testSupport'

const at = '2026-09-27T12:00:00.000Z'
const message = (executionId: string, id: string, sequence: string, content: string, role: 'user' | 'assistant' = 'assistant'): AgentChatExecutionItem =>
  ({ executionId, id, sequence, revision: sequence, entry: { kind: 'message', message: { id: `${executionId}:${id}`, role, content, nativeMessageComplete: true } } })
const tool = (executionId: string, id: string, sequence: string, title: string, status: 'running' | 'completed', output: string, truncated = false): AgentChatExecutionItem =>
  ({ executionId, id, sequence, revision: sequence, entry: { kind: 'activity', activity: { id, kind: 'tool', title, status, output, ...(truncated ? { truncated } : {}) } } })
const executions = (checkState: 'running' | 'completed'): AgentChatExecutionActivityPage['executions'] => [
  { executionId: 'execution-main', label: 'Execution', attempt: 1, state: 'completed', createdAt: at, revision: '3' },
  { executionId: 'execution-check', label: 'Interval check 1', attempt: 1, tickIndex: 1, state: checkState, createdAt: at, revision: '9', hasEarlierItems: true },
]
const snapshot = (checkState: 'running' | 'completed', items: AgentChatExecutionItem[]): AgentChatExecutionActivityPage =>
  ({ mode: 'snapshot', executions: executions(checkState), hasEarlierExecutions: false, cursor: '{}', hasMoreChanges: false, items })

beforeEach(installChatSource)
afterEach(() => { useConversationDraftStore.getState().clearAllDrafts(); vi.unstubAllGlobals() })

describe('Board Agent chat live execution activity', () => {
  it('shows each labeled execution with its messages and tool steps live, and one compact working line in the composer', async () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.empty)
    state.context.runId = 'selected-run'
    state.availability = { canSend: false, reason: 'run_active', message: 'Working — you can message it when it finishes' }
    const mounted = mountChat(state)
    mounted.mock.setExecutionActivity(state.context, snapshot('running', [
      message('execution-main', 'final', '3', 'Initial work finished'),
      message('execution-check', 'prompt', '5', 'Check CI', 'user'),
      tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'On branch main', true),
    ]))
    await mounted.ready()
    const check = await screen.findByRole('region', { name: 'Interval check 1 · Working' })
    expect(within(check).getByText('Ran git status')).toBeVisible()
    expect(within(check).getByText('Running')).toBeVisible()
    expect(screen.getByText('Initial work finished')).toBeVisible()
    const composer = screen.getByRole('textbox', { name: 'Message' })
    expect(composer).toBeDisabled()
    expect(composer).toHaveAttribute('placeholder', 'Working — you can message it when it finishes')

    server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', ({ request }) => {
      const params = new URL(request.url).searchParams
      if (params.get('itemId') === 'cmd-1') return HttpResponse.json({ ...snapshot('running', [
        tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'On branch main\nfull output')]), mode: 'item', cursor: undefined })
      if (params.get('before') === '5') return HttpResponse.json({ ...snapshot('running', [
        message('execution-check', 'older', '4', 'Older check note')]), mode: 'earlier', cursor: undefined,
        executions: executions('running').map((execution) => ({ ...execution, hasEarlierItems: false })) })
      return undefined
    }))
    fireEvent.click(within(check).getByText('Ran git status'))
    fireEvent.click(within(check).getByRole('button', { name: 'Show full details' }))
    expect(await within(check).findByText(/full output/)).toBeVisible()
    fireEvent.click(within(check).getByRole('button', { name: 'Load earlier activity' }))
    expect(await within(check).findByText('Older check note')).toBeVisible()

    mounted.mock.setExecutionActivity(state.context, snapshot('completed', [
      message('execution-check', 'prompt', '5', 'Check CI', 'user'),
      tool('execution-check', 'cmd-1', '9', 'git status', 'completed', 'clean'),
    ]))
    expect(await screen.findByRole('region', { name: 'Interval check 1 · Completed' }, { timeout: 3000 })).toBeVisible()
  })
})

describe('mergeExecutionActivity', () => {
  it('upserts changed entries in execution and native order without regressing a newer revision', () => {
    const base = mergeExecutionActivity(undefined, snapshot('running', [
      message('execution-main', 'final', '3', 'Done'), tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'partial')]))
    const changed = mergeExecutionActivity(base, { ...snapshot('running', [
      { ...tool('execution-check', 'cmd-1', '7', 'git status', 'completed', 'clean'), revision: '9' },
      message('execution-check', 'reply', '8', 'All green')]), mode: 'changes', cursor: '{"execution-check":"9"}' })
    expect(changed.items.map((item) => item.id)).toEqual(['final', 'cmd-1', 'reply'])
    expect(changed.items[1]?.entry).toMatchObject({ activity: { status: 'completed', output: 'clean' } })
    const stale = mergeExecutionActivity(changed, { ...snapshot('running', [tool('execution-check', 'cmd-1', '7', 'git status', 'running', 'partial')]),
      mode: 'earlier', cursor: undefined })
    expect(stale.items[1]?.entry).toMatchObject({ activity: { status: 'completed' } })
    expect(stale.cursor).toBe('{"execution-check":"9"}')
    expect(stale.executions[1]?.hasEarlierItems).toBe(true)
  })
})
