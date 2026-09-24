import { useEffect, useLayoutEffect, useRef } from 'react'
import { sameGraphScope, type WorkspaceBoardInspection } from '@graphql/contracts/wave25'
import { useGraphPresentationStore } from '../graph/useGraphPresentation'
import { useRunGraphContext } from '../run-graph/context'
import { useWorkflowBoard } from './context'

const key = (value: WorkspaceBoardInspection) => JSON.stringify([value.runNodeId, value.runRelationshipId, value.runExchangeKey])

/** URL is the authority. The existing renderer's selection store is only its projection.
 * Coalesce the old controls' sequential setters into one URL change, not three history entries. */
export function RunBoardSelection() {
  const board = useWorkflowBoard(), { scope } = useRunGraphContext(), store = useGraphPresentationStore()
  const projecting = useRef(false)
  const active = !!board?.run && sameGraphScope(board.run, scope)
  const nodeId = active ? board?.inspection.runNodeId : undefined
  const relationshipId = active ? board?.inspection.runRelationshipId : undefined
  const exchangeKey = active ? board?.inspection.runExchangeKey : undefined
  const incoming = key({ runNodeId: nodeId, runRelationshipId: relationshipId, runExchangeKey: exchangeKey })
  const last = useRef(incoming)
  useLayoutEffect(() => {
    if (!active) return
    projecting.current = true
    last.current = incoming
    store.setState({ selectedNodeIds: new Set(nodeId ? [nodeId] : []), focusedEdgeId: relationshipId, focusedExchangeKey: exchangeKey })
    projecting.current = false
  }, [active, incoming, nodeId, relationshipId, exchangeKey, store])
  useEffect(() => {
    if (!active || !board) return
    let disposed = false, scheduled = false
    const unsubscribe = store.subscribe(() => {
      if (projecting.current || scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (disposed || projecting.current) return
        const current = store.getState()
        const runNodeId = current.selectedNodeIds.values().next().value as string | undefined
        const selection = { runNodeId, runRelationshipId: current.focusedEdgeId, runExchangeKey: current.focusedExchangeKey }
        if (runNodeId && selection.runRelationshipId) return
        if (key(selection) === last.current) return
        last.current = key(selection)
        board.selectInspection(selection)
      })
    })
    return () => { disposed = true; unsubscribe() }
  }, [active, board, store])
  return null
}
