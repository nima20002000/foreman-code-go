import { useCallback, useEffect } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { graphRecordKey, selectGraphNode, selectGraphInteraction, selectGraphReview, shareGraphRecordOrSelection } from './cache'
import { useRunGraphContext } from './context'
import type { AcceptedBatchListener, RunGraphRecord } from './types'

/** Every leaf is cache-only: no queryFn, timer, refetch handle, or alternate fact store. */
export function useRunGraphSelection<T>(select: (record: RunGraphRecord) => T): T | undefined {
  const { scope, generation } = useRunGraphContext()
  const query = useQuery<RunGraphRecord, Error, T>({
    queryKey: graphRecordKey(scope, generation), queryFn: skipToken, enabled: false,
    staleTime: Infinity, refetchInterval: false, refetchOnMount: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    structuralSharing: shareGraphRecordOrSelection, select,
  })
  return query.data
}
export function useRunGraphNode(workflowNodeId: string) {
  return useRunGraphSelection(useCallback((record: RunGraphRecord) => selectGraphNode(record, workflowNodeId), [workflowNodeId]))
}

/** Agent 8: animate ONLY mode=live and discard every cue from a no-longer-current epoch. */
export function useAfterGraphBatchAccepted(listener: AcceptedBatchListener): void {
  const { subscribe } = useRunGraphContext()
  useEffect(() => subscribe(listener), [subscribe, listener])
}

export function useRunGraphInteraction(interactionId: string) {
  return useRunGraphSelection(useCallback((record: RunGraphRecord) => selectGraphInteraction(record, interactionId), [interactionId]))
}
export function useRunGraphReview(reviewJobId: string) {
  return useRunGraphSelection(useCallback((record: RunGraphRecord) => selectGraphReview(record, reviewJobId), [reviewJobId]))
}
