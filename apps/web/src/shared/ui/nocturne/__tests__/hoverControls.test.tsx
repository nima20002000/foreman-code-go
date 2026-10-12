import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentNodeView } from '../Canvas'
import { SignalEdgeShape } from '../../../../features/graph/SignalEdgeShape'
import type { FloatingCurve } from '../../../../features/graph/signalEdge'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps node actions reachable across a gap and preserves them through status updates', () => {
  const action = vi.fn()
  const node = (statusLabel: string) => <AgentNodeView name="Worker" harnessLabel="Codex"
    statusLabel={statusLabel} onAction={action} />
  const view = render(node('Running'))
  const core = screen.getByRole('button', { name: 'Worker, Codex, Running' })
  const owner = core.parentElement!
  const chat = screen.getByRole('button', { name: 'Open Worker chat' })
  fireEvent.pointerEnter(core)
  fireEvent.pointerLeave(owner)
  act(() => vi.advanceTimersByTime(100))
  expect(owner).toHaveAttribute('data-hovered', 'true')
  fireEvent.pointerEnter(chat)
  view.rerender(node('Waiting'))
  act(() => vi.advanceTimersByTime(200))
  expect(screen.getByRole('button', { name: 'Open Worker chat' })).toBe(chat)
  expect(owner).toHaveAttribute('data-hovered', 'true')
  fireEvent.click(chat)
  expect(action).toHaveBeenCalledWith('chat', expect.anything())
  fireEvent.pointerLeave(owner)
  act(() => vi.advanceTimersByTime(160))
  expect(owner).not.toHaveAttribute('data-hovered')
  expect(screen.getByRole('button', { name: 'Open Worker chat' })).toBe(chat)
})

it('preserves an edge label element when hover visibility changes', () => {
  const curve = { path: 'M 0 0 L 100 100', mid: { x: 50, y: 50, angle: 45 } } as FloatingCurve
  const edge = (showLabel: boolean) => <svg><SignalEdgeShape id="edge" curve={curve}
    label="Hands off" showLabel={showLabel} /></svg>
  const view = render(edge(false))
  const label = screen.getByText('Hands off')
  expect(label.parentElement).toHaveAttribute('aria-hidden', 'true')
  view.rerender(edge(true))
  expect(screen.getByText('Hands off')).toBe(label)
  expect(label.parentElement).toHaveAttribute('aria-hidden', 'false')
  view.rerender(edge(false))
  expect(screen.getByText('Hands off')).toBe(label)
})
