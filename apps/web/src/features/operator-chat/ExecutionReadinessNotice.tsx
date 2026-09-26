import type { AgentHarness } from '@graphql/contracts'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button } from '../../shared/ui/nocturne'
import { getExecutionReadiness } from './executionReadiness'

export function ExecutionReadinessNotice({ harness }: { harness: AgentHarness }) {
  const query = useQuery({ queryKey: ['execution-readiness', harness],
    queryFn: ({ signal }) => getExecutionReadiness(harness, signal), retry: false, staleTime: 30_000 })
  if (query.isPending) return <p role="status">Checking execution eligibility…</p>
  if (query.isError) return <Alert tone="warning" title="Execution eligibility is unverified"
    action={<Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Check again</Button>}>
    MCP installation alone does not confirm that agents can run. You can continue browsing.
  </Alert>
  const result = query.data
  if (result.status === 'eligible') return null
  return <Alert tone="warning" title={result.status === 'unverified' ? 'Execution eligibility is unverified' : 'Execution is unavailable'}
    action={<Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Check again</Button>}>
    <p>{result.reason?.message}</p>
    <p>This checks saved harness defaults, independently of MCP installation. You can continue browsing.</p>
  </Alert>
}
