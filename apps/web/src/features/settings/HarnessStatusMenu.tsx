import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AgentHarnessSchema, type AgentHarness } from '@graphql/contracts'
import { getExecutionReadiness } from '../operator-chat/executionReadiness'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import './harnessStatusMenu.css'

function HarnessStatus({ harness }: { harness: AgentHarness }) {
  const epoch = useHarnessSessionEpoch()
  const query = useQuery({
    queryKey: ['workbench', 'management', 'harness-readiness', epoch, harness],
    queryFn: ({ signal }) => getExecutionReadiness(harness, signal),
    enabled: !sessionIsSwitching(), retry: false, staleTime: 30_000, refetchInterval: 30_000,
  })
  const name = harness === 'codex' ? 'Codex' : 'OpenCode'
  const state = query.isError || query.isPaused ? 'unverified' : query.data?.status ?? 'checking'
  const label = state === 'eligible' ? 'Available' : state === 'blocked' ? 'Unavailable' : state === 'checking' ? 'Checking' : 'Unverified'
  const detail = query.isError ? 'Could not check harness availability.' : query.data?.reason?.message ?? 'Availability with saved harness settings. Workspace checks run when execution starts.'
  return <Link to="/settings/harnesses" search={{ harness, section: 'model' }} className="harness-status-link"
    aria-label={`${name}: ${label}`} title={`${name}: ${label}. ${detail}`}>
    <span className={`harness-status-light harness-status-light--${state}`} aria-hidden="true" />
    <span className="harness-status-initial" aria-hidden="true">{name[0]}</span>
    <span className="harness-status-name">{name}</span>
  </Link>
}

export function HarnessStatusMenu() {
  return <nav className="harness-status-menu" aria-label="Harness availability">
    {AgentHarnessSchema.options.map((harness) => <HarnessStatus key={harness} harness={harness} />)}
  </nav>
}
