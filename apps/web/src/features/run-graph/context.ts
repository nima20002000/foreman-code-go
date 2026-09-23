import { createContext, useContext } from 'react'
import type { RunGraphScope } from '@graphql/contracts/wave25'
import type { AcceptedBatchListener } from './types'

export type RunGraphContextValue = {
  scope: RunGraphScope
  generation: number
  subscribe: (listener: AcceptedBatchListener) => () => void
  retry: () => void
}
export const RunGraphContext = createContext<RunGraphContextValue | undefined>(undefined)
export function useRunGraphContext(): RunGraphContextValue {
  const context = useContext(RunGraphContext)
  if (!context) throw new Error('RunGraphProvider is required')
  return context
}
