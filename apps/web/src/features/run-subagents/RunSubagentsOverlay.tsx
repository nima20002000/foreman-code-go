import { useRef } from 'react'
import { ViewportPortal } from '@xyflow/react'
import { layoutSubagents, isTerminalSubagent, type SubagentLayoutNode } from './layout'
import { useRunSubagents, type SubagentsScope } from './query'
import { useSelectedSubagent } from './selection'
import { SubagentPanel } from './SubagentPanel'
import './runSubagents.css'

export function RunSubagentsOverlay({ scope, nodes }: {
  scope: SubagentsScope; nodes: readonly SubagentLayoutNode[]
}) {
  const query = useRunSubagents(scope)
  const { selected, select } = useSelectedSubagent(scope)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const closePanel = () => {
    void select(null).then(() => trigger.current?.focus())
  }
  // A failed read (including revoked access) cannot leave cached circles visible.
  const children = query.isError ? [] : query.data?.pages.flatMap((page) => page.items.map((item) => item.subagent)) ?? []
  const circles = layoutSubagents(nodes, children)
  return <>
    <ViewportPortal>
      <div className="run-subagents-overlay">
        <svg className="run-subagents-links" aria-hidden="true">
          {circles.map(({ subagent, x, y, fromX, fromY }) => <line key={subagent.id} x1={fromX} y1={fromY} x2={x} y2={y} />)}
        </svg>
        {circles.map(({ subagent, x, y, parentId }) => {
          const name = subagent.name || 'Subagent'
          const label = `${name}, ${subagent.provider}, ${subagent.status}${subagent.evidence !== 'confirmed' ? `, ${subagent.evidence}` : ''}`
          return <button key={subagent.id} ref={(element) => {
            if (selected === subagent.id && element) trigger.current = element
          }} type="button" className="run-subagent-circle nodrag nopan"
            data-parent-id={parentId} data-subagent-id={subagent.id} data-inactive={isTerminalSubagent(subagent.status)}
            data-uncertain={subagent.evidence !== 'confirmed' || subagent.status === 'unknown'}
            style={{ left: x, top: y }} title={label} aria-label={label} aria-pressed={selected === subagent.id}
            onClick={(event) => { event.stopPropagation(); trigger.current = event.currentTarget; void select(subagent.id) }}>
            <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
          </button>
        })}
      </div>
    </ViewportPortal>
    {(query.isError || query.hasNextPage || query.data?.pages.some((page) => page.projection === 'catching-up') || circles.length < children.length) &&
      <div className="run-subagents-notice nopan nodrag" role="status">
        {query.isError ? <><span>Subagents unavailable. </span><button type="button" onClick={() => void query.refetch()}>Retry</button></> : <>
          {query.hasNextPage && <button type="button" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>Load more subagents</button>}
          {query.data?.pages.some((page) => page.projection === 'catching-up') && <span>Subagent evidence catching up.</span>}
          {circles.length < children.length && <span>Some attachments await parent evidence.</span>}
        </>}
      </div>}
    {!query.isError && selected && <SubagentPanel key={`${scope.runId}:${selected}`} scope={scope} subagentId={selected} onClose={closePanel} />}
  </>
}
