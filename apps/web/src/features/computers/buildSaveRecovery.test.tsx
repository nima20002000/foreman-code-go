import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import type { BuildComputerBatchUpdate, BuildComputerUpdate } from '@foreman-code/contracts/build-computers'
import { server } from '../../mocks/server'
import { computerKey } from '../../shared/api/computerActivity'
import { beginSessionChange, finishSessionChange, sessionGeneration } from '../../shared/api/sessionBoundary'
import { buildComputerKeys } from '../../shared/api/buildComputers'
import { buildComputerCommandKey, clearBuildComputerCommandMemory } from '../../shared/api/buildComputerCommands'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import type { LeaveTarget } from '../../shared/ui/unsavedChanges'
import { ComputerRows } from './ComputerRows'
import { computersFixture, deviceName, mainId, mainTarget, registration } from './computersTestFixture'

const blocker = vi.hoisted(() => ({ current: undefined as unknown as {
  shouldBlockFn(input: { current: LeaveTarget; next: LeaveTarget }): Promise<boolean>
  enableBeforeUnload(): boolean
} }))
vi.mock('@tanstack/react-router', () => ({ useBlocker: (options: typeof blocker.current) => { blocker.current = options } }))
afterEach(() => { window.sessionStorage.clear(); act(() => clearBuildComputerCommandMemory()) })

async function ready() {
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeEnabled())
}
function unknownResponses(commit?: (input: BuildComputerBatchUpdate | BuildComputerUpdate) => void) {
  const calls: unknown[] = []
  const respond = async ({ request }: { request: Request }) => {
    const input = await request.json() as BuildComputerBatchUpdate | BuildComputerUpdate
    calls.push(input)
    if (calls.length === 1) commit?.(input)
    return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Response lost' } }, { status: 503 })
  }
  server.use(http.post('*/api/management/settings/build-computers/update', respond),
    http.post('*/api/management/settings/build-computers/batch-update', respond))
  return calls
}
it('keeps an uncertain committed toggle locked and reconciles its original command rather than a refresh', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  const calls = unknownResponses(input => {
    if ('updates' in input) input.updates.forEach(change => f.update({ ...change, commandId: input.commandId }))
    else f.update(input)
  })
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Builds on Main PC' }))
  const retry = await screen.findByRole('button', { name: 'Retry original save' })
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).not.toBeChecked()
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeDisabled()
  await act(() => f.client.refetchQueries({ queryKey: buildComputerKeys.root, type: 'all' }))
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).not.toBeChecked()
  expect(retry).toBeEnabled()
  const input = calls[0] as BuildComputerBatchUpdate
  const saved = input.updates.map(change => f.statuses.get(computerKey(change.target))!)
  server.use(http.post('*/api/management/settings/build-computers/batch-update', async ({ request }) => {
    calls.push(await request.json())
    return HttpResponse.json({ computers: saved })
  }))
  await userEvent.setup().click(retry)
  await ready()
  expect(calls).toHaveLength(3)
  expect(calls.every(value => JSON.stringify(value) === JSON.stringify(calls[0]))).toBe(true)
  expect(screen.queryByRole('button', { name: 'Retry original save' })).not.toBeInTheDocument()
})
it('does not write old-session snapshots into the new session or retry after access changes', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const respond = async () => {
    calls++
    started()
    await held
    return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Old session' } }, { status: 503 })
  }
  server.use(http.post('*/api/management/settings/build-computers/update', respond),
    http.post('*/api/management/settings/build-computers/batch-update', respond))
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Builds on Main PC' }))
  await waiting
  let releaseReads!: () => void
  const heldReads = new Promise<void>(resolve => { releaseReads = resolve })
  server.use(http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
    const { target } = await request.json() as BuildComputerUpdate
    await heldReads
    return HttpResponse.json(f.statuses.get(computerKey(target)))
  }))
  const oldGeneration = sessionGeneration()
  act(() => { beginSessionChange(); finishSessionChange() })
  const key = buildComputerKeys.computer(mainTarget)
  const newer = { ...f.statuses.get(computerKey(mainTarget))!,
    preference: { ...f.statuses.get(computerKey(mainTarget))!.preference, revision: 9, buildEnabled: false } }
  f.client.setQueryData(key, newer)
  f.statuses.set(computerKey(mainTarget), newer)
  release()
  await waitFor(() => expect(f.client.isMutating()).toBe(0))
  const observed = f.client.getQueryData(key)
  releaseReads()
  expect(sessionGeneration()).toBeGreaterThan(oldGeneration)
  expect(observed).toEqual(newer)
  expect(calls).toBe(1)
})
it('keeps the drag snapshot when a background refresh starts before the drop', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  const list = screen.getByRole('list', { name: 'Computers in build priority order' })
  const rows = within(list).getAllByRole('listitem')
  fireEvent.dragStart(within(rows[1]!).getByTitle('Drag to reorder'),
    { dataTransfer: { setData() {}, effectAllowed: '' } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  server.use(http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
    const { target } = await request.json() as BuildComputerUpdate
    await held
    return HttpResponse.json(f.statuses.get(computerKey(target)))
  }))
  let refresh!: Promise<void>
  await act(async () => {
    refresh = f.client.refetchQueries({ queryKey: buildComputerKeys.root })
    await Promise.resolve()
  })
  fireEvent.dragOver(rows[0]!)
  fireEvent.drop(rows[0]!)
  release()
  await refresh
  await waitFor(() => expect(f.writes.length).toBeGreaterThan(0))
  await waitFor(() => expect(within(list).getAllByRole('listitem')[0]).toHaveAccessibleName(deviceName))
})
it('guards navigation and reload and recovers the same unconfirmed batch after remount', async () => {
  const f = computersFixture(<UnsavedChangesProvider>
    <ComputerRows mainId={mainId} devices={[registration]} />
  </UnsavedChangesProvider>)
  await ready()
  const calls = unknownResponses()
  await userEvent.setup().click(screen.getByRole('button', { name: `Move ${deviceName} up` }))
  await screen.findByRole('button', { name: 'Retry original save' })
  expect(blocker.current.enableBeforeUnload()).toBe(true)
  let leaving!: Promise<boolean>
  act(() => { leaving = blocker.current.shouldBlockFn({
    current: { pathname: '/settings', search: {} }, next: { pathname: '/workspaces', search: {} },
  }) })
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close dialog' }))
  expect(await leaving).toBe(true)
  const original = calls[0]
  expect(JSON.parse(window.sessionStorage.getItem(buildComputerCommandKey(mainId))!)).toEqual(original)
  f.rendered.unmount()
  clearBuildComputerCommandMemory()
  const restored = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  server.use(http.post('*/api/management/settings/build-computers/batch-update', async ({ request }) => {
    calls.push(await request.json())
    return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Response lost' } }, { status: 503 })
  }))
  const retry = await screen.findByRole('button', { name: 'Retry original save' })
  expect(await screen.findByRole('switch', { name: 'Builds on Main PC' })).toBeDisabled()
  await userEvent.setup().click(retry)
  await waitFor(() => expect(calls).toHaveLength(4))
  expect(calls.every(value => JSON.stringify(value) === JSON.stringify(original))).toBe(true)
  restored.client.clear()
})
it('retains an uncertain save when a retry loses permission', async () => {
  computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  const calls = unknownResponses()
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Builds on Main PC' }))
  const retry = await screen.findByRole('button', { name: 'Retry original save' })
  server.use(http.post('*/api/management/settings/build-computers/batch-update', async ({ request }) => {
    calls.push(await request.json())
    return HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Permission removed' } }, { status: 403 })
  }))
  await userEvent.setup().click(retry)
  await waitFor(() => expect(calls).toHaveLength(3))
  expect(await screen.findByRole('button', { name: 'Retry original save' })).toBeEnabled()
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeDisabled()
  expect(calls[2]).toEqual(calls[0])
})
it('sends no changes when the recovery command cannot be stored', async () => {
  const f = computersFixture(<ComputerRows mainId={mainId} devices={[registration]} />)
  await ready()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Builds on Main PC' }))
  expect(await screen.findByText('Save recovery is unavailable. No changes were sent.')).toBeVisible()
  expect(f.writes).toHaveLength(0)
  expect(f.batches).toHaveLength(0)
  expect(screen.getByRole('switch', { name: 'Builds on Main PC' })).toBeChecked()
})
