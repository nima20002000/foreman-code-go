import { fireEvent, render, screen } from '@testing-library/react'
import { Position } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { HandoffEdge } from './GraphElements'
import { GraphPresentationProvider } from './GraphPresentation'
import { GraphGeometryContext } from './graphContexts'

const path = { sourceX: 0, sourceY: 0, targetX: 120, targetY: 80,
  sourcePosition: Position.Right, targetPosition: Position.Left }

describe('lazy edge interaction controls', () => {
  it('keeps inactive edges SVG-only and mounts controls for the touched edge', () => {
    const onRemove = vi.fn()
    const { container } = render(<GraphPresentationProvider><svg>
      <HandoffEdge {...path} id="one" source="a" target="b" data={{ explanation: 'First connection', onRemove }} />
      <HandoffEdge {...path} id="two" source="b" target="c" data={{ explanation: 'Second connection', onRemove }} />
    </svg></GraphPresentationProvider>)
    expect(container.querySelectorAll('foreignObject')).toHaveLength(0)
    fireEvent.click(screen.getByRole('group', { name: 'Connection from b to c' }))
    expect(container.querySelectorAll('foreignObject')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Remove connection from a to b' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection from b to c' }))
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('two')
  })

  it('supports keyboard inspect, Escape from a nested control, and edge deletion', () => {
    const onRemove = vi.fn()
    render(<GraphPresentationProvider><svg><HandoffEdge {...path} id="one" source="a" target="b"
      data={{ explanation: 'First connection', onRemove }} /></svg></GraphPresentationProvider>)
    const edge = screen.getByRole('group', { name: 'Connection from a to b' })
    fireEvent.focus(edge)
    fireEvent.keyDown(edge, { key: 'Enter' })
    expect(screen.getByRole('note')).toHaveTextContent('First connection')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Inspect connection from a to b' }), { key: 'Escape' })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    fireEvent.keyDown(edge, { key: 'Delete' })
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('one')
  })

  it('does not expose removal or mutate a read-only Run canvas', () => {
    const onRemove = vi.fn()
    render(<GraphPresentationProvider><GraphGeometryContext.Provider value={{ readOnly: true,
      beginResize: () => undefined, finishResize: () => undefined }}><svg>
      <HandoffEdge {...path} id="one" source="a" target="b" data={{ explanation: 'First connection', onRemove }} />
    </svg></GraphGeometryContext.Provider></GraphPresentationProvider>)
    const edge = screen.getByRole('group', { name: 'Connection from a to b' })
    fireEvent.focus(edge)
    expect(screen.getByRole('button', { name: 'Inspect connection from a to b' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Remove connection from a to b' })).not.toBeInTheDocument()
    fireEvent.keyDown(edge, { key: 'Backspace' })
    expect(onRemove).not.toHaveBeenCalled()
  })
})
