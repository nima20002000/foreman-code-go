import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RunGraphScopeSchema, type RunGraphScope } from '@graphql/contracts/wave25'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from './cache'
import { RunGraphContext } from './context'
import { retainRunGraphSync } from './sync'
import type { AcceptedBatchListener, RunGraphRecord } from './types'

export function RunGraphProvider({ scope: input, children }: { scope: RunGraphScope; children: ReactNode }) {
  const { workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion } = input
  const scope = useMemo(() => RunGraphScopeSchema.parse({ workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion }),
    [workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion])
  const client = useQueryClient()
  const generation = sessionGeneration()
  const lease = useRef<ReturnType<typeof retainRunGraphSync> | undefined>(undefined)
  const [listeners] = useState(() => new Set<AcceptedBatchListener>())
  useEffect(() => {
    try {
      const held = retainRunGraphSync(client, scope)
      lease.current = held
      const unsubscribe = held.subscribe((cue) => {
        for (const listener of [...listeners]) {
          try { listener(cue) } catch { /* Optional visuals cannot affect synchronization. */ }
        }
      })
      return () => { unsubscribe(); held.release(); lease.current = undefined }
    } catch {
      client.setQueryData<RunGraphRecord>(graphRecordKey(scope, generation), {
        kind: 'run-graph-cache', scope, epoch: (client.getQueryData<RunGraphRecord>(graphRecordKey(scope, generation))?.epoch ?? 0) + 1, transport: { phase: 'denied', reason: 'GRAPH_READ_ACCESS_DENIED' },
      })
    }
  }, [client, scope, generation, listeners])
  const value = useMemo(() => ({ scope, generation,
    subscribe: (listener: AcceptedBatchListener) => {
      const subscription: AcceptedBatchListener = (cue) => listener(cue)
      listeners.add(subscription)
      return () => { listeners.delete(subscription) }
    },
    retry: () => lease.current?.retry(),
  }), [scope, generation, listeners])
  return <RunGraphContext.Provider value={value}>{children}</RunGraphContext.Provider>
}
