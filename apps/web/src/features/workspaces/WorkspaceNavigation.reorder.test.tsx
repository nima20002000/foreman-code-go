import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceShell } from '../../shared/ui/WorkspaceShell'
import { useNavigationOrderStore } from './navigationOrder'

const sectionsGroup = 'workspace:workspace-1:sections'
const sectionsGroupTwo = 'workspace:workspace-2:sections'
const workspacesGroup = 'workspaces'

type Layout = { top: number; height: number; left?: number; width?: number }

function rect(input: Layout): DOMRect {
  const left = input.left ?? 0
  const width = input.width ?? 240
  return {
    x: left,
    y: input.top,
    top: input.top,
    left,
    width,
    height: input.height,
    right: left + width,
    bottom: input.top + input.height,
    toJSON: () => ({}),
  } as DOMRect
}

function stubLayout(rects: Map<Element, DOMRect>) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rects.get(this) ?? rect({ top: 0, height: 0, width: 0 })
  })
}

function layoutList(group: string, top: number, itemHeight = 30): Map<Element, DOMRect> {
  const rects = new Map<Element, DOMRect>()
  const list = document.querySelector(`[data-reorder-group="${group}"]`)
  if (!list) throw new Error(`Missing reorder group ${group}`)
  const items = [...list.querySelectorAll<HTMLElement>('[data-reorder-id]')].filter(
    (element) => element.closest('[data-reorder-group]') === list,
  )
  items.forEach((item, index) => {
    rects.set(item, rect({ top: top + index * itemHeight, height: itemHeight }))
  })
  rects.set(list, rect({ top, height: items.length * itemHeight }))
  return rects
}

function reorderIds(group: string): string[] {
  const list = document.querySelector(`[data-reorder-group="${group}"]`)
  if (!list) throw new Error(`Missing reorder group ${group}`)
  return [...list.querySelectorAll<HTMLElement>('[data-reorder-id]')]
    .filter((element) => element.closest('[data-reorder-group]') === list)
    .map((element) => element.dataset.reorderId ?? '')
}

function item(group: string, id: string): HTMLElement {
  const list = document.querySelector(`[data-reorder-group="${group}"]`)
  const element = list?.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`)
  if (!element) throw new Error(`Missing reorder item ${group}/${id}`)
  return element
}

function pointerDrag(
  source: HTMLElement,
  target: { x: number; y: number },
  pointerType: 'mouse' | 'touch' = 'mouse',
  start: { x: number; y: number } = target,
) {
  fireEvent.pointerDown(source, {
    button: 0,
    pointerId: 1,
    pointerType,
    clientX: start.x,
    clientY: start.y,
  })
  fireEvent.pointerMove(window, {
    pointerId: 1,
    pointerType,
    clientX: target.x,
    clientY: target.y,
    buttons: 1,
  })
  fireEvent.pointerMove(window, {
    pointerId: 1,
    pointerType,
    clientX: target.x,
    clientY: target.y,
    buttons: 1,
  })
  fireEvent.pointerUp(window, {
    pointerId: 1,
    pointerType,
    clientX: target.x,
    clientY: target.y,
  })
}

afterEach(() => {
  useNavigationOrderStore.getState().reset()
})

describe('sidebar menu reordering', () => {
  it('swaps sibling sections with Alt+Arrow keys and announces the new position', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const files = await screen.findByRole('link', { name: 'Files' })
    files.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')

    expect(reorderIds(sectionsGroup)).toEqual([
      'agents',
      'files',
      'workflows',
      'tasks',
      'runs',
    ])
    expect(screen.getByTestId('navigation-reorder-announcement')).toHaveTextContent(
      'Moved Files to position 2 of 5',
    )
  })

  it('keeps nested submenu contents and the active section intact after a section swap', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const agents = await screen.findByRole('link', { name: 'Agents' })
    agents.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    expect(reorderIds(sectionsGroup).slice(0, 2)).toEqual(['workflows', 'agents'])
    expect(await screen.findByTestId('agent-navigation')).toBeVisible()
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')

    await user.click(screen.getByRole('button', { name: 'Collapse agents in Website' }))
    expect(screen.queryByTestId('agent-navigation')).not.toBeInTheDocument()
  })

  it('reorders sibling workspace entries with Alt+Arrow keys', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )

    const docs = await screen.findByTestId('workspace-entry-workspace-2')
    docs.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')

    expect(reorderIds(workspacesGroup)).toEqual(['workspace-2', 'workspace-1'])
    expect(item(workspacesGroup, 'workspace-2')).toContainElement(docs)
  })

  it('reorders siblings by pointer drag and suppresses the click that follows it', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    await screen.findByRole('link', { name: 'Files' })

    stubLayout(layoutList(sectionsGroup, 100))

    pointerDrag(item(sectionsGroup, 'files'), { x: 50, y: 125 }, 'mouse', { x: 50, y: 175 })

    expect(reorderIds(sectionsGroup)).toEqual([
      'agents',
      'files',
      'workflows',
      'tasks',
      'runs',
    ])
    expect(screen.getByTestId('navigation-reorder-announcement')).toHaveTextContent(
      'Moved Files to position 2 of 5',
    )
  })

  it('never moves a dragged item into another workspace list', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Expand Docs' }))

    const rects = new Map([
      ...layoutList(sectionsGroup, 100),
      ...layoutList(sectionsGroupTwo, 400),
    ])
    stubLayout(rects)

    pointerDrag(item(sectionsGroup, 'files'), { x: 50, y: 415 }, 'mouse', { x: 50, y: 175 })

    expect(reorderIds(sectionsGroup)).toEqual([
      'agents',
      'workflows',
      'files',
      'tasks',
      'runs',
    ])
    expect(reorderIds(sectionsGroupTwo)).toEqual([
      'agents',
      'workflows',
      'files',
      'tasks',
      'runs',
    ])
  })

  it('does not arm workspace reordering when a nested section is dragged', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )
    await user.click(await screen.findByRole('button', { name: 'Expand Docs' }))

    const nestedFile = item(sectionsGroup, 'files')
    expect(nestedFile.closest('[data-reorder-id="workspace-1"]')).toBeNull()
    const rects = new Map([
      ...layoutList(workspacesGroup, 50, 200),
      ...layoutList(sectionsGroup, 100),
      ...layoutList(sectionsGroupTwo, 400),
    ])
    stubLayout(rects)

    pointerDrag(nestedFile, { x: 50, y: 350 }, 'mouse', { x: 50, y: 175 })

    expect(reorderIds(workspacesGroup)).toEqual(['workspace-1', 'workspace-2'])
    expect(reorderIds(sectionsGroup)).toEqual([
      'agents',
      'workflows',
      'files',
      'tasks',
      'runs',
    ])
  })

  it('does not reorder on a quick touch movement that is a scroll', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    await screen.findByRole('link', { name: 'Files' })

    stubLayout(layoutList(sectionsGroup, 100))

    pointerDrag(item(sectionsGroup, 'files'), { x: 50, y: 140 }, 'touch', { x: 50, y: 175 })

    expect(reorderIds(sectionsGroup)).toEqual([
      'agents',
      'workflows',
      'files',
      'tasks',
      'runs',
    ])
  })

  it('reorders after a touch hold', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    await screen.findByRole('link', { name: 'Files' })

    stubLayout(layoutList(sectionsGroup, 100))

    vi.useFakeTimers()
    try {
      const source = item(sectionsGroup, 'files')
      fireEvent.pointerDown(source, {
        button: 0,
        pointerId: 1,
        pointerType: 'touch',
        clientX: 50,
        clientY: 175,
      })
      act(() => {
        vi.advanceTimersByTime(400)
      })
      fireEvent.pointerMove(window, {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 50,
        clientY: 125,
        buttons: 1,
      })
      fireEvent.pointerUp(window, {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 50,
        clientY: 125,
      })
    } finally {
      vi.useRealTimers()
    }

    expect(reorderIds(sectionsGroup).slice(0, 2)).toEqual(['agents', 'files'])
  })

  it('keeps the session-local order across shell remounts without touching the URL', async () => {
    const user = userEvent.setup()
    const first = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const files = await screen.findByRole('link', { name: 'Files' })
    files.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    first.unmount()

    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    expect(await screen.findByRole('link', { name: 'Files' })).toBeVisible()
    expect(reorderIds(sectionsGroup).slice(0, 3)).toEqual(['agents', 'files', 'workflows'])
  })
})
