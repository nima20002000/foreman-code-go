import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../mocks/server'
import { useConversationDraftStore } from '../conversationDraftStore'
import { useRunsSelectorUi } from '../../runs-selector/uiStore'
import { installChatSource } from './testSupport'
import { clients, envelope, installSelectedHandlers, mountSelected, nodeId, scope, selectedRoute } from './sch10.testSupport'

beforeEach(() => {
  installChatSource()
  useRunsSelectorUi.getState().setOpen(null)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  vi.useRealTimers()
  useRunsSelectorUi.getState().setOpen(null)
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
})

const missing = (runId: string) => HttpResponse.json({ kind: 'unavailable',
  target: { ...scope, runId, workflowNodeId: nodeId }, reason: 'execution_missing' })
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }

describe('Selected Run execution discovery refresh', () => {
  it('continues missing-execution discovery after a transient service failure', async () => {
    const source = installSelectedHandlers()
    let reads = 0
    server.use(http.get(selectedRoute, () => {
      reads++
      if (reads === 1) return missing('run-a')
      if (reads === 2) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Try again' } }, { status: 503 })
      return HttpResponse.json(envelope(source.states.get('run-a')!))
    }))
    const mounted = await mountSelected()
    await screen.findByText('Execution unavailable')
    const href = mounted.router.history.location.href
    await tick()
    await screen.findByText('Load failed')
    await tick()
    await screen.findByText('Reply execution-run-a')
    expect(reads).toBe(3)
    expect(mounted.router.history.location.href).toBe(href)
    expect(source.current.calls).toHaveLength(0)
  })

  it('counts transient failures toward the automatic discovery bound', async () => {
    installSelectedHandlers()
    let reads = 0
    server.use(http.get(selectedRoute, () => {
      reads++
      return reads === 1 ? missing('run-a')
        : HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Try again' } }, { status: 503 })
    }))
    await mountSelected()
    await screen.findByText('Execution unavailable')
    for (let expected = 2; expected <= 20; expected++) {
      await tick()
      await waitFor(() => expect(reads).toBe(expected))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
    }
    await tick()
    expect(reads).toBe(20)
  })

  it('recovers when an execution appears without changing the selected Run', async () => {
    const source = installSelectedHandlers()
    let created = false
    let reads = 0
    server.use(http.get(selectedRoute, () => {
      reads++
      return created ? HttpResponse.json(envelope(source.states.get('run-a')!)) : missing('run-a')
    }))
    const mounted = await mountSelected()
    await screen.findByText('Execution unavailable')
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    const href = mounted.router.history.location.href
    created = true
    await tick()
    await screen.findByText('Reply execution-run-a')
    expect(reads).toBeGreaterThan(1)
    expect(screen.getByLabelText('Selected Run')).toHaveTextContent('run-a')
    expect(mounted.router.history.location.href).toBe(href)
    expect(source.current.calls).toHaveLength(0)
  })

  it('bounds automatic missing-execution reads and leaves an explicit refresh available', async () => {
    const source = installSelectedHandlers()
    let reads = 0
    let created = false
    server.use(http.get(selectedRoute, () => {
      reads++
      return created ? HttpResponse.json(envelope(source.states.get('run-a')!)) : missing('run-a')
    }))
    await mountSelected()
    await screen.findByText('Execution unavailable')
    for (let expected = 2; expected <= 20; expected++) {
      await tick()
      await waitFor(() => expect(reads).toBe(expected))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh execution' })).toBeEnabled())
    }
    await tick()
    expect(reads).toBe(20)
    created = true
    await userEvent.click(screen.getByRole('button', { name: 'Refresh execution' }))
    await screen.findByText('Reply execution-run-a')
  })

  it('stops automatic discovery after access is denied', async () => {
    const source = installSelectedHandlers()
    let reads = 0
    server.use(http.get(selectedRoute, () => {
      reads++
      return reads === 1 ? missing('run-a')
        : HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })
    }))
    await mountSelected()
    await screen.findByText('Execution unavailable')
    await tick()
    await screen.findByText('No access')
    await tick()
    expect(reads).toBe(2)
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    expect(source.current.calls).toHaveLength(0)
  })

  it('does not continue discovery for a Run after leaving its selection', async () => {
    const source = installSelectedHandlers()
    let missingReads = 0
    server.use(http.get(selectedRoute, ({ params }) => {
      if (params.runId === 'run-a') {
        missingReads++
        return missing('run-a')
      }
      return HttpResponse.json(envelope(source.states.get('run-b')!))
    }))
    const mounted = await mountSelected()
    await screen.findByText('Execution unavailable')
    await mounted.select('run-b')
    await screen.findByText('Reply execution-run-b')
    await tick()
    expect(missingReads).toBe(1)
    expect(screen.queryByText('Execution unavailable')).toBeNull()
  })
})
