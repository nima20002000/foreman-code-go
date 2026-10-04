import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { useCurrentRunQuery } from './currentRunQuery'

export function CurrentRunObserver({ scope }: { scope: RepeatGraphScopeV3 }) { useCurrentRunQuery(scope); return null }
