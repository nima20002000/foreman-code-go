import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { ManagedWorkflow, WorkflowReorderInput } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkflowNavigation } from './WorkflowNavigation'
import { WorkflowDirectory } from './WorkflowDirectory'

const makeWorkflow = (name: string, workspaceId = 'workspace-1'): ManagedWorkflow => ({
  workflow: { id: name, name, workspaceId, executionSemanticsVersion: 3, entryNodeId: null,
    executionCondition: { kind: 'manual' }, nodes: [], edges: [] },
  revision: 1, archivedAt: null, currentVersionId: null,
})

function listNames(region: HTMLElement): string[] {
  return within(region).getAllByRole('link').map(link => link.querySelector('.nav-item-label')?.textContent ?? link.textContent!)
}

function page(items: ManagedWorkflow[], orderRevision = 4, nextCursor: string | null = null) {
  return HttpResponse.json({ items, orderRevision, pageInfo: { nextCursor } })
}

it('optimistically moves workflows using buttons and keyboard, saves and keeps focus and directory order', async () => {
  const original = ['Alpha', 'Beta', 'Gamma'].map(name => makeWorkflow(name))
  let items = original
  let revision = 4
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const bodies: WorkflowReorderInput[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => page(items, revision)),
    http.put('/api/management/workspaces/workspace-1/workflows/order', async ({ request }) => {
      const input = await request.json() as WorkflowReorderInput
      bodies.push(input)
      if (bodies.length === 1) await gate
      items = input.workflowIds.map(id => original.find(item => item.workflow.id === id)!)
      revision += 1
      return HttpResponse.json({ value: { workspaceId: input.workspaceId, workflowIds: input.workflowIds,
        orderRevision: revision }, replayed: false })
    }),
  )
  const user = userEvent.setup()
  renderWithRouter(<><WorkflowNavigation workspaceId="workspace-1" />
    <section aria-label="Directory"><WorkflowDirectory workspaceId="workspace-1" /></section></>)
  const sidebar = await screen.findByRole('region', { name: 'Workspace workflows' })
  const directory = screen.getByRole('region', { name: 'Directory' })
  await within(sidebar).findByRole('link', { name: /^Beta/ })
  await within(directory).findByRole('link', { name: 'Beta' })
  await user.click(within(sidebar).getByRole('button', { name: 'Move Beta up' }))
  try {
    await waitFor(() => expect(listNames(sidebar)).toEqual(['Beta', 'Alpha', 'Gamma']))
    expect(listNames(directory)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(within(sidebar).getByRole('link', { name: /^Beta/ })).toHaveFocus()
    expect(within(sidebar).getByRole('button', { name: 'Move Alpha up' })).toBeDisabled()
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ expectedRevision: 4, workflowIds: ['Beta', 'Alpha', 'Gamma'] })
  } finally { release() }
  await waitFor(() => expect(within(sidebar).getByRole('button', { name: 'Move Alpha up' })).toBeEnabled())
  const beta = within(sidebar).getByRole('link', { name: /^Beta/ })
  beta.focus()
  await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
  await waitFor(() => expect(listNames(sidebar)).toEqual(['Alpha', 'Beta', 'Gamma']))
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[1]).toMatchObject({ expectedRevision: 5, workflowIds: ['Alpha', 'Beta', 'Gamma'] })
  expect(beta).toHaveFocus()
})

it('rolls back a conflicting move, refreshes the persisted order and uses its revision for the next move', async () => {
  const original = ['Alpha', 'Beta', 'Gamma'].map(name => makeWorkflow(name))
  let items = original
  let revision = 4
  const bodies: WorkflowReorderInput[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => page(items, revision)),
    http.put('/api/management/workspaces/workspace-1/workflows/order', async ({ request }) => {
      const input = await request.json() as WorkflowReorderInput
      bodies.push(input)
      if (bodies.length === 1) {
        items = [original[2]!, original[0]!, original[1]!]
        revision = 5
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Order changed.' } }, { status: 409 })
      }
      items = input.workflowIds.map(id => original.find(item => item.workflow.id === id)!)
      revision += 1
      return HttpResponse.json({ value: { workspaceId: input.workspaceId, workflowIds: input.workflowIds,
        orderRevision: revision }, replayed: false })
    }),
  )
  const user = userEvent.setup()
  renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Move Beta up' }))
  const sidebar = screen.getByRole('region', { name: 'Workspace workflows' })
  expect(await screen.findByRole('alert')).toHaveTextContent('Your move was undone')
  expect(listNames(sidebar)).toEqual(['Gamma', 'Alpha', 'Beta'])
  await user.click(screen.getByRole('button', { name: 'Move Beta up' }))
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[1]?.expectedRevision).toBe(5)
  await waitFor(() => expect(listNames(sidebar)).toEqual(['Gamma', 'Beta', 'Alpha']))
})

it('retains the original command after a lost response and blocks further moves until retry confirms it', async () => {
  const original = ['Alpha', 'Beta'].map(name => makeWorkflow(name))
  let items = original
  const bodies: WorkflowReorderInput[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => page(items, bodies.length ? 5 : 4)),
    http.put('/api/management/workspaces/workspace-1/workflows/order', async ({ request }) => {
      const input = await request.json() as WorkflowReorderInput
      bodies.push(input)
      items = [original[1]!, original[0]!]
      if (bodies.length === 1) return HttpResponse.error()
      return HttpResponse.json({ value: { workspaceId: input.workspaceId, workflowIds: input.workflowIds,
        orderRevision: 5 }, replayed: true })
    }),
  )
  const user = userEvent.setup()
  renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Move Beta up' }))
  await screen.findByRole('button', { name: 'Retry saving order' })
  expect(screen.getByRole('button', { name: 'Move Alpha up' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry saving order' }))
  await waitFor(() => expect(bodies).toHaveLength(2))
  expect(bodies[1]).toEqual(bodies[0])
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving order' })).not.toBeInTheDocument())
})

it('moves across loaded page boundaries and reads the saved order after remounting', async () => {
  const original = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(name => makeWorkflow(name))
  let items = original
  let revision = 4
  const bodies: WorkflowReorderInput[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', ({ request }) => {
      const second = new URL(request.url).searchParams.has('cursor')
      return page(items.slice(second ? 2 : 0, second ? 4 : 2), revision, second ? null : 'page-two')
    }),
    http.put('/api/management/workspaces/workspace-1/workflows/order', async ({ request }) => {
      const input = await request.json() as WorkflowReorderInput
      bodies.push(input)
      items = input.workflowIds.map(id => original.find(item => item.workflow.id === id)!)
      revision += 1
      return HttpResponse.json({ value: { workspaceId: input.workspaceId, workflowIds: input.workflowIds,
        orderRevision: revision }, replayed: false })
    }),
  )
  const user = userEvent.setup()
  const first = renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Show more workflows' }))
  await user.click(await screen.findByRole('button', { name: 'Move Gamma up' }))
  await waitFor(() => expect(bodies).toHaveLength(1))
  expect(bodies[0]?.workflowIds).toEqual(['Alpha', 'Gamma', 'Beta', 'Delta'])
  await waitFor(() => expect(screen.queryByText('Saving workflow order…')).not.toBeInTheDocument())
  expect(listNames(screen.getByRole('region', { name: 'Workspace workflows' }))).toEqual(['Alpha', 'Gamma', 'Beta', 'Delta'])
  first.unmount()
  renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" />)
  await screen.findByRole('link', { name: /^Gamma/ })
  expect(listNames(screen.getByRole('region', { name: 'Workspace workflows' }))).toEqual(['Alpha', 'Gamma'])
})

it('drags only within the workspace list and cancels a drag with Escape', async () => {
  const items = ['Alpha', 'Beta'].map(name => makeWorkflow(name))
  const requests: WorkflowReorderInput[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => page(items)),
    http.get('/api/management/workspaces/workspace-2/workflows', () => page([makeWorkflow('Other', 'workspace-2')])),
    http.put('/api/management/workspaces/workspace-1/workflows/order', async ({ request }) => {
      const input = await request.json() as WorkflowReorderInput
      requests.push(input)
      items.reverse()
      return HttpResponse.json({ value: { workspaceId: input.workspaceId, workflowIds: input.workflowIds,
        orderRevision: 5 }, replayed: false })
    }),
  )
  renderWithRouter(<><section aria-label="First workspace"><WorkflowNavigation workspaceId="workspace-1" /></section>
    <section aria-label="Second workspace"><WorkflowNavigation workspaceId="workspace-2" /></section></>)
  const alpha = await screen.findByRole('link', { name: /^Alpha/ })
  const beta = screen.getByRole('link', { name: /^Beta/ })
  const list = within(screen.getByRole('region', { name: 'First workspace' })).getByRole('list')
  await screen.findByRole('link', { name: /^Other/ })
  const bounds = (top: number, height: number) => ({ left: 0, right: 250, top, bottom: top + height,
    x: 0, y: top, width: 250, height, toJSON: () => ({}) }) as DOMRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === list) return bounds(0, 60)
    if (this === alpha.parentElement) return bounds(0, 30)
    if (this === beta.parentElement) return bounds(30, 30)
    return bounds(100, 30)
  })
  const start = () => fireEvent.pointerDown(alpha, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 15 })
  const move = (x: number) => {
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 55 })
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 55 })
  }
  const drop = () => fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse' })
  start()
  move(300)
  drop()
  expect(requests).toHaveLength(0)
  expect(listNames(screen.getByRole('region', { name: 'Second workspace' }))).toEqual(['Other'])
  start()
  move(20)
  fireEvent.keyDown(window, { key: 'Escape' })
  drop()
  expect(requests).toHaveLength(0)
  start()
  move(20)
  drop()
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ workspaceId: 'workspace-1', workflowIds: ['Beta', 'Alpha'] })
})

it('recovers a stale load-more cursor by reading the latest first page', async () => {
  let changed = false
  server.use(http.get('/api/management/workspaces/workspace-1/workflows', ({ request }) => {
    if (new URL(request.url).searchParams.has('cursor')) {
      changed = true
      return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Order changed.' } }, { status: 409 })
    }
    return page([makeWorkflow(changed ? 'Gamma' : 'Alpha')], changed ? 5 : 4, changed ? null : 'cursor')
  }))
  const user = userEvent.setup()
  renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Show more workflows' }))
  await screen.findByRole('link', { name: /^Gamma/ })
  expect(screen.queryByRole('link', { name: /^Alpha/ })).not.toBeInTheDocument()
})
