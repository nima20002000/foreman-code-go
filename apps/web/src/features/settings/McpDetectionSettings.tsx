import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { AgentHarness } from '@graphql/contracts'
import { Alert, Badge, Button, Combobox, Icon } from '../../shared/ui/nocturne'
import { useManagedWorkspacesQuery, useManagedWorkspaceQuery } from '../../shared/api/query'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { useProtectedAccessError } from '../auth/useProtectedAccessError'
import { McpAccessNotice, McpConnectionCard } from './McpConnectionCard'
import './mcpConnections.css'

type Props = { workspaceId?: string; harness?: AgentHarness }

function WorkspaceEvidence({ workspaceId, harness, returnTo }: Props & { workspaceId: string; returnTo: string }) {
  const query = useManagedWorkspaceQuery(workspaceId)
  const accessError = useProtectedAccessError(query)
  const current = query.data?.workspace.id === workspaceId ? query.data : undefined
  const retry = <Button size="sm" loading={query.isFetching} leading={<Icon name="refresh" size={16} />}
    onClick={() => void query.refetch({ cancelRefetch: false })}>Try again</Button>

  if (accessError) return <McpAccessNotice error={accessError} returnTo={returnTo} retry={retry} />
  if (!current) return query.isError
    ? <Alert live tone="danger" title="Couldn't load this workspace" action={retry}>{query.error.message}</Alert>
    : <p className="mcp-pending" role="status"><Icon name="clock" size={16} />
      {query.fetchStatus === 'paused' ? 'Waiting for a connection…' : 'Checking the workspace folder…'}</p>

  const location = current.executionLocation
  const status = current.locationValidation.status
  const ready = Boolean(location) && status === 'ready'
  return <div className="mcp-content">
    {query.isError ? <Alert tone="warning" title="Workspace details couldn't update" action={retry}>
      Showing the last saved location.
    </Alert> : null}
    {ready && location ? <div className="mcp-connection-grid">
      {(harness ? [harness] : ['codex', 'opencode'] as const).map((provider) => <McpConnectionCard
        key={JSON.stringify([workspaceId, provider, location.runnerId, location.rootPath])}
        workspaceId={workspaceId} harness={provider} location={location} returnTo={returnTo} />)}
    </div> : status === 'restricted' ? <Alert tone="warning" title="Folder access is restricted" action={retry}>
      Ask the workspace owner for access, then try again.
    </Alert> : <div className="mcp-folder-notice">
      <span className="mcp-provider-icon"><Icon name="folder" size={22} /></span>
      <div><strong>{status === 'unavailable' ? 'The workspace folder is unavailable' : 'Choose a workspace folder'}</strong>
        <p>App connections are checked from this folder.</p></div>
      <Link className="n-button n-button--secondary n-button--sm" to="/workspaces/$workspaceId/settings/location" params={{ workspaceId }}>
        <Icon name="folder" size={16} />{status === 'unavailable' ? 'Change folder' : 'Choose folder'}
      </Link>
    </div>}
    {current.locationValidation.status === 'unavailable' ? <details className="mcp-location-details"><summary>Folder details</summary>
      <p>{current.locationValidation.error.message}</p>
    </details> : null}
  </div>
}

/** A picker belongs only in the global harness preview, never inside a known workspace. */
function WorkspaceSelector({ harness, returnTo }: { harness?: AgentHarness; returnTo: string }) {
  const [selected, setSelected] = useState('')
  const query = useManagedWorkspacesQuery()
  const accessError = useProtectedAccessError(query)
  const retry = <Button size="sm" loading={query.isFetching} onClick={() => void query.refetch({ cancelRefetch: false })}>Try again</Button>
  if (accessError) return <McpAccessNotice error={accessError} returnTo={returnTo} retry={retry} />
  if (!query.data) return query.isError
    ? <Alert live tone="danger" title="Couldn't load workspaces" action={retry}>{query.error.message}</Alert>
    : <p className="mcp-pending" role="status">{query.fetchStatus === 'paused' ? 'Waiting for a connection…' : 'Loading workspaces…'}</p>

  const choices = query.data.items.map((item) => ({
    value: item.workspace.id, label: item.workspace.name,
    description: item.locationValidation.status === 'restricted' ? 'Folder access restricted'
      : item.locationValidation.status === 'unavailable' ? 'Folder unavailable'
        : item.executionLocation ? 'Workspace folder set' : 'Needs a workspace folder',
  }))
  return <div className="mcp-content">
    {query.isError ? <Alert tone="warning" title="Workspace list couldn't update" action={retry} /> : null}
    {choices.length ? <Combobox label="Workspace" value={selected} options={choices} onValueChange={setSelected}
      placeholder="Choose a workspace…" /> : <div className="mcp-folder-notice">
      <Icon name="folder" size={22} /><div><strong>No workspaces yet</strong><p>Create a workspace to check its app connections.</p></div>
      <Link className="n-button n-button--secondary n-button--sm" to="/workspaces">Workspaces<Icon name="arrow" size={16} /></Link>
    </div>}
    {selected ? <WorkspaceEvidence key={selected} workspaceId={selected} harness={harness} returnTo={returnTo} /> : null}
  </div>
}

export function McpDetectionSettings(props: Props) {
  const epoch = useHarnessSessionEpoch()
  const returnTo = props.workspaceId ? `/workspaces/${encodeURIComponent(props.workspaceId)}/settings` : '/settings/harnesses'
  return <section className="mcp-connections" aria-label="Workspace App MCP">
    <header className="mcp-heading">
      <div className="mcp-heading-title"><Icon name="workflow" size={20} /><h2>App connections</h2><Badge>MCP</Badge></div>
      <p>{props.workspaceId ? 'Connections to this workspace’s app tools.' : 'Check app connections for a workspace.'}</p>
    </header>
    {props.workspaceId ? <WorkspaceEvidence key={`${props.workspaceId}:${epoch}`} {...props} workspaceId={props.workspaceId} returnTo={returnTo} />
      : <WorkspaceSelector key={epoch} harness={props.harness} returnTo={returnTo} />}
  </section>
}
