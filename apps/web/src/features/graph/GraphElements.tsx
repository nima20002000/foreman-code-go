import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BaseEdge, Handle, NodeResizer, Position, getSmoothStepPath,
  type NodeProps, type EdgeProps, type MiniMapNodeProps } from '@xyflow/react'
import { Button, Icon, WorkflowNodeCard } from '../../shared/ui/nocturne'
import { useDismissableSurface, type SurfaceDismissReason } from '../../shared/ui/useDismissableSurface'
import { AgentSettingsForm } from './AgentSettingsForm'
import { GraphGeometryContext, GraphNodeMenuContext } from './graphContexts'
import { useGraphPresentation, useGraphPresentationStore } from './useGraphPresentation'
import { useGraphNodeRuntime } from './useGraphNodeRuntime'
import { presentGraphNodeRuntime } from './nodePresentation'
import { GRAPH_NODE_MIN_WIDTH, GRAPH_NODE_MAX_WIDTH, GRAPH_NODE_MIN_HEIGHT, GRAPH_NODE_MAX_HEIGHT } from './mapper'
import type { GraphNode, GraphEdge, GraphHandleSide } from './types'
import './graphRendering.css'

const HANDLE_SIDES: GraphHandleSide[] = ['top', 'right', 'bottom', 'left']
const HANDLE_POSITIONS: Record<GraphHandleSide, Position> = {
  top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left,
}

function agentNodeSubtitle(data: GraphNode['data']): string {
  const harness = data.agent.harness ?? data.agent.harnessConfiguration?.harness
  const harnessLabel = harness === 'opencode' ? 'OpenCode'
    : harness === 'codex' ? 'Codex'
      : data.harnessLabel ?? data.agent.harnessSummary?.label ?? 'Agent'
  const responsibility = data.role ?? data.agent.productRole ?? 'Agent'
  return `${harnessLabel} · ${responsibility}`
}

function agentNodeIcon(data: GraphNode['data']): 'workflow' | 'code' | 'eye' | 'bot' {
  const responsibility = `${data.role ?? ''} ${data.agent.productRole ?? ''}`.toLowerCase()
  if (responsibility.includes('review')) return 'eye'
  if (responsibility.includes('orchestrat')) return 'workflow'
  if (responsibility.includes('develop') || responsibility.includes('cod')) return 'code'
  return 'bot'
}


export const AgentNode = memo(function AgentNode({ data: staticData, isConnectable }: NodeProps<GraphNode>) {
  const presentation = useGraphPresentationStore()
  const geometry = useContext(GraphGeometryContext)
  const selected = useGraphPresentation((state) => state.selectedNodeIds.has(staticData.workflowNodeId))
  const entering = useGraphPresentation((state) => state.enteringNodeIds.has(staticData.workflowNodeId))
  const departureCue = useGraphPresentation((state) => state.departingNodeIds.has(staticData.workflowNodeId))
  const departing = Boolean(staticData.departing && departureCue)
  const menuOpen = useGraphPresentation((state) => state.openMenuNodeId === staticData.workflowNodeId)
  const runtime = useGraphNodeRuntime(staticData.workflowNodeId, staticData.agentId)
  const data = { ...staticData, entering, departing }
  // Legacy mapper fields are not a second source of runtime truth. With no
  // scoped canonical leaf, even a plausible static activity remains unavailable.
  const detachedRuntime = !runtime.activity && (staticData.liveActivity !== undefined
    || staticData.runState !== undefined || staticData.runOutcome !== undefined || staticData.runActive !== undefined
    || staticData.reviewState !== undefined || staticData.executionState !== undefined
    || staticData.agent.executionState !== undefined || staticData.agent.status !== undefined
    || staticData.agent.harnessSummary?.status !== undefined)
  const nodeView = presentGraphNodeRuntime(runtime.activity, runtime.unavailable || departing || detachedRuntime)
  const status = nodeView.label
  const nodeMenu = useContext(GraphNodeMenuContext)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState({ top: 8, left: 8 })

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const gap = 8
    const width = Math.min(432, window.innerWidth - 16)
    const estimatedHeight = Math.min(420, window.innerHeight - 16)
    const fitsRight = rect.right + gap + width <= window.innerWidth - 8
    const left = fitsRight ? rect.right + gap : Math.max(8, rect.left - gap - width)
    const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - estimatedHeight - 8))
    setMenuPosition({ top, left })
  }, [])

  const setMenuOpen = useCallback((nextOpen: boolean) => {
    if (nodeMenu) nodeMenu.setOpenMenuNodeId(nextOpen ? data.workflowNodeId : undefined)
    else presentation.getState().setOpenMenuNodeId(nextOpen ? data.workflowNodeId : undefined)
  }, [data.workflowNodeId, nodeMenu, presentation])

  const closeMenu = useCallback((reason: SurfaceDismissReason) => {
    setMenuOpen(false)
    if (reason === 'escape') triggerRef.current?.focus()
  }, [setMenuOpen])

  useDismissableSurface({
    open: menuOpen,
    onDismiss: closeMenu,
    surfaceRef: menuRef,
    triggerRef,
  })

  useEffect(() => {
    if (!menuOpen) return
    positionMenu()
    menuRef.current?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [menuOpen, positionMenu])

  if (data.departing) {
    return (
      <div className="workflow-agent-node-departing" aria-hidden="true">
        <WorkflowNodeCard
          title={data.label}
          subtitle={agentNodeSubtitle(data)}
          statusLabel={status}
          tone={nodeView.tone}
          icon={agentNodeIcon(data)}
          meta={nodeView.actionLabel}
        />
      </div>
    )
  }

  return (
    <article
      className={`workflow-agent-node${selected ? ' workflow-agent-node-selected' : ''}${nodeView.state === 'working' || nodeView.state === 'waiting' ? ' workflow-agent-node-active' : ''}${data.entering ? ' workflow-agent-node-entering' : ''}`}
      data-testid={`agent-node-${data.agentId}`}
      data-agent-id={data.agentId}
      data-workflow-node-id={data.workflowNodeId}
      data-execution-state={nodeView.state}
      data-run-state={nodeView.state}
      data-live-event={nodeView.eventId}
      onFocus={() => presentation.getState().setFocusedNodeId(data.workflowNodeId)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) presentation.getState().setFocusedNodeId(undefined)
      }}
    >
      <NodeResizer
        isVisible={selected && !geometry?.readOnly}
        minWidth={GRAPH_NODE_MIN_WIDTH}
        maxWidth={GRAPH_NODE_MAX_WIDTH}
        minHeight={GRAPH_NODE_MIN_HEIGHT}
        maxHeight={GRAPH_NODE_MAX_HEIGHT}
        handleClassName="workflow-agent-node-resize-handle nodrag"
        lineClassName="workflow-agent-node-resize-line"
        onResizeStart={() => geometry?.beginResize()}
        onResizeEnd={(_event, size) => geometry
          ? geometry.finishResize(data.workflowNodeId, size.width, size.height,
            Number.isFinite(size.x) && Number.isFinite(size.y) ? { x: size.x, y: size.y } : undefined)
          : data.onResize?.(data.workflowNodeId, size.width, size.height)}
      />
      {selected && !geometry?.readOnly ? <span className="visually-hidden">Resize handles are available around this selected node.</span> : null}
      {HANDLE_SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={HANDLE_POSITIONS[side]}
          isConnectable={isConnectable}
          className="workflow-agent-node-handle"
        />
      ))}
      <WorkflowNodeCard
        className="workflow-agent-node-button"
        title={data.label}
        subtitle={agentNodeSubtitle(data)}
        statusLabel={status}
        tone={nodeView.tone}
        icon={agentNodeIcon(data)}
        selected={selected}
        working={nodeView.working}
        meta={nodeView.actionLabel}
        ariaLabel={`${data.label} agent, ${data.stepLabel}, ${status}${nodeView.actionLabel ? `, ${nodeView.actionLabel}` : ''}`}
        onSelect={(event) => data.onSelect?.(
          data.agentId,
          data.workflowNodeId,
          event.ctrlKey || event.metaKey,
        )}
      />
      {!geometry?.readOnly && data.onOpenSettings ? <Button
        ref={triggerRef}
        variant="ghost"
        className="n-icon-button workflow-agent-node-menu-trigger nodrag"
        aria-label={`Open actions for ${data.label}`}
        title="Node actions"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation()
          if (!menuOpen) {
            positionMenu()
            data.onOpenSettings?.(data.agentId, data.workflowNodeId)
          }
          setMenuOpen(!menuOpen)
        }}
      >
        <Icon name="more" size={17} />
      </Button> : null}
      {menuOpen && !geometry?.readOnly && data.onOpenSettings ? createPortal((
        <div ref={menuRef} className="agent-settings-inspector nodrag nowheel" style={menuPosition} role="dialog" aria-modal={false} aria-label={`${data.label} settings`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // A portal still bubbles through React: do not let Delete remove graph nodes.
            event.stopPropagation()
            if (event.key === 'Escape') { event.preventDefault(); closeMenu('escape') }
          }}>
          <AgentSettingsForm
            workspaceId={nodeMenu?.workspaceId}
            workflowApprovalHandler={nodeMenu?.workflowApprovalHandler}
            designatedOrchestrator={nodeMenu?.workflowApprovalHandler === 'orchestrator'
              && nodeMenu.designatedOrchestratorAgentId === data.agentId}
            agent={data.agent}
            initialPrompt={data.initialPrompt}
            executionPolicy={data.executionPolicy}
            workflowNodeCount={data.workflowNodeCount}
            onClose={() => {
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
            onRemove={() => {
              data.onRemove?.(data.workflowNodeId)
              setMenuOpen(false)
            }}
            onSave={(agent, initialPrompt, executionPolicy) => {
              data.onSaveSettings?.(data.workflowNodeId, agent, initialPrompt, executionPolicy)
              setMenuOpen(false)
              window.setTimeout(() => triggerRef.current?.focus(), 0)
            }}
          />
        </div>
      ), document.body) : null}
    </article>
  )
})

/** Minimap agents read as small blue dots instead of full node rectangles. */
export function AgentMinimapDot({
  id,
  x,
  y,
  width,
  height,
  color,
  className,
  selected,
  strokeColor,
  strokeWidth,
  shapeRendering,
  onClick,
}: MiniMapNodeProps) {
  const classes = ['react-flow__minimap-node']
  if (selected) classes.push('selected')
  if (className) classes.push(className)
  const radius = Math.max(6, Math.round(Math.min(36, Math.min(width, height) / 3)))
  return (
    <circle
      className={classes.join(' ')}
      cx={x + width / 2}
      cy={y + height / 2}
      r={radius}
      fill={color}
      stroke={strokeColor}
      strokeWidth={strokeWidth}
      style={{ fill: color, stroke: strokeColor, strokeWidth }}
      shapeRendering={shapeRendering}
      onClick={onClick ? (event) => onClick(event, id) : undefined}
    />
  )
}

/** Inactive edges contain SVG only. Focus, pointer, and touch activate the rich controls. */
export const HandoffEdge = memo(function HandoffEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius,
  style, markerStart, markerEnd, interactionWidth, data,
}: EdgeProps<GraphEdge>) {
  const presentation = useGraphPresentationStore()
  const focused = useGraphPresentation((state) => state.focusedEdgeId === id)
  const entering = useGraphPresentation((state) => state.enteringEdgeId === id)
  const geometry = useContext(GraphGeometryContext)
  const [hovered, setHovered] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const active = !data?.departing && (hovered || focused)
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10,
  })
  const description = `Connection from ${source} to ${target}${typeof label === 'string' && label ? `: ${label}` : ''}`
  const removeLabel = `Remove connection from ${source} to ${target}${typeof label === 'string' && label ? `: ${label}` : ''}`
  const canRemove = !data?.departing && !geometry?.readOnly && Boolean(data?.onRemove)

  return <g className={entering ? 'workflow-graph-edge-new' : undefined}
    role="group" tabIndex={data?.departing ? -1 : 0} aria-hidden={data?.departing || undefined} aria-label={description}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHovered(true) }}
    onPointerLeave={() => setHovered(false)}
    onFocus={() => presentation.getState().setFocusedEdgeId(id)}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        presentation.getState().setFocusedEdgeId(undefined)
        setInspecting(false)
      }
    }}
    onClick={(event) => {
      event.stopPropagation()
      event.currentTarget.focus?.()
      presentation.getState().setFocusedEdgeId(id)
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setInspecting(false)
        setHovered(false)
        event.currentTarget.focus?.()
        presentation.getState().setFocusedEdgeId(undefined)
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        presentation.getState().setFocusedEdgeId(id)
        setInspecting(true)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        event.stopPropagation()
        if (canRemove) data?.onRemove?.(id)
      }
    }}>
    <title>{data?.explanation ?? description}</title>
    <BaseEdge id={id} className="n-flow-base workflow-graph-edge-path" path={edgePath}
      label={label} labelX={labelX} labelY={labelY} labelStyle={labelStyle} labelShowBg={labelShowBg}
      labelBgStyle={labelBgStyle} labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius}
      style={style} markerStart={markerStart} markerEnd={markerEnd} interactionWidth={interactionWidth} />
    {active ? <foreignObject className="graph-edge-active-controls"
      x={labelX - 112} y={labelY - 44} width={224} height={inspecting ? 112 : 38}>
      <div className="graph-edge-controls nodrag nopan">
        <Button variant="secondary" aria-label={`Inspect ${description.toLowerCase()}`} title="Inspect connection"
          onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}
          onClick={(event) => { event.stopPropagation(); setInspecting((current) => !current) }}>
          <span aria-hidden="true">i</span>
        </Button>
        {canRemove ? <Button variant="secondary" className="workflow-graph-edge-remove"
          aria-label={removeLabel} title="Remove connection"
          onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}
          onClick={(event) => { event.stopPropagation(); data?.onRemove?.(id) }}>
          <Icon name="close" size={13} />
        </Button> : null}
      </div>
      {inspecting ? <div className="graph-edge-inspection" role="note">{data?.explanation ?? description}</div> : null}
    </foreignObject> : null}
  </g>
})
