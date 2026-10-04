import type { AgentHarness } from '@foreman-code/contracts'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button } from '../../shared/ui/nocturne'
import { getExecutionReadiness } from './executionReadiness'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

export function ExecutionReadinessNotice({ harness, configurationVersionId }: { harness: AgentHarness; configurationVersionId?: string }) {
  const epoch = useHarnessSessionEpoch()
  const query = useQuery({ queryKey: ['workbench', 'management', 'operator-readiness', epoch, harness, configurationVersionId],
    enabled: !sessionIsSwitching(), queryFn: ({ signal }) => getExecutionReadiness(harness, signal, 'operator-configuration', configurationVersionId),
    retry: false, staleTime: 30_000 })
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
    <p>This checks the selected Operator configuration and its host profile. You can continue browsing.</p>
  </Alert>
}
