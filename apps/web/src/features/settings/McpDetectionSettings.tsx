import { useState } from 'react'
import type { McpDetection } from '@graphql/contracts'
import { Alert, Button, Combobox, StatusBadge, type Tone } from '../../shared/ui/nocturne'
import { useManagedWorkspacesQuery, useManagedWorkspaceQuery, useMcpDetectionQuery } from '../../shared/api/query'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import './harnessWorkbench.css'

const labels: Record<McpDetection['state'], string> = {
  not_detected: 'Not detected', misconfigured: 'Misconfigured', status_unavailable: 'Detected · status unavailable',
  connected: 'Detected · connected', disabled: 'Detected · disabled', authentication_required: 'Detected · authentication required',
  broken: 'Detected · broken', check_failed: 'Check failed',
}
const help: Record<McpDetection['state'], string> = {
  not_detected: 'The effective configuration was inspected successfully, but the GraphQL App MCP entry is absent.',
  misconfigured: 'The named entry exists, but its endpoint, transport, or credential environment reference does not match.',
  status_unavailable: 'The resolved entry matches. The provider did not supply trustworthy live connection health.',
  connected: 'Provider-native evidence reports a connected matching entry.',
  disabled: 'The matching native MCP entry is disabled.',
  authentication_required: 'The provider reports that authentication or client registration is required.',
  broken: 'The provider reports a connection or tool-discovery failure.',
  check_failed: 'Inspection could not run. This state is unknown, not evidence that MCP is absent.',
}
const tones: Record<McpDetection['state'], Tone> = {
  not_detected: 'neutral', misconfigured: 'warning', status_unavailable: 'info', connected: 'success', disabled: 'neutral',
  authentication_required: 'warning', broken: 'danger', check_failed: 'danger',
}
function Detection({ workspaceId, harness }: { workspaceId: string; harness: 'codex' | 'opencode' }) {
  const query = useMcpDetectionQuery(workspaceId, harness)
  if (query.isPending) return <p role="status">Checking {harness === 'codex' ? 'Codex' : 'OpenCode'} App MCP…</p>
  if (query.isError) return <Alert tone="danger" title={query.error.message} action={<Button size="sm" onClick={() => void query.refetch()}>Retry</Button>} />
  const result = query.data
  return <div className="harness-evidence-result"><div className="harness-section-heading"><strong>{harness === 'codex' ? 'Codex' : 'OpenCode'}</strong>
    <StatusBadge label={labels[result.detection.state]} tone={tones[result.detection.state]} />
    <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button></div>
    <p className="harness-muted">{help[result.detection.state]}</p>
    {result.detection.state !== 'connected' && result.detection.detail ? <p className="harness-muted">{result.detection.detail}</p> : null}
    <details className="harness-evidence-details"><summary>Connection details</summary><dl className="harness-change-details">
      <div><dt>Runner</dt><dd>{result.runnerId}</dd></div><div><dt>Folder</dt><dd>{result.workingDirectory}</dd></div>
      <div><dt>Version</dt><dd>{result.providerVersion}</dd></div><div><dt>Checked</dt><dd>{new Date(result.detection.checkedAt).toLocaleString()}</dd></div>
    </dl>{result.nativeFilters.enabledTools?.length ? <p>Allowed: {result.nativeFilters.enabledTools.join(', ')}</p> : null}
      {result.nativeFilters.disabledTools?.length ? <p>Blocked: {result.nativeFilters.disabledTools.join(', ')}</p> : null}
      {result.nativeFilters.diagnostics?.map((detail) => <p key={detail}>{detail}</p>)}</details>
    {result.detection.state !== 'connected' ? <p className="harness-muted">Inspect this exact runner and workspace; GraphQL will not rewrite it automatically.</p> : null}
  </div>
}
function WorkspaceEvidence({ workspaceId: initial, harness }: { workspaceId?: string; harness?: 'codex' | 'opencode' }) {
  const [selected, setSelected] = useState(initial ?? '')
  const workspaces = useManagedWorkspacesQuery()
  const workspace = useManagedWorkspaceQuery(selected, Boolean(selected))
  const items = workspaces.data?.items ?? []
  const choices = items.map((item) => ({ value: item.workspace.id, label: item.workspace.name,
    description: item.locationValidation.status === 'restricted' ? 'Runner access restricted'
      : item.executionLocation ? `${item.executionLocation.runnerId} · ${item.executionLocation.rootPath}` : 'No execution location',
    disabled: !item.executionLocation || item.locationValidation.status === 'restricted',
  }))
  const current = workspace.data
  const ready = initial ? selected === initial
    : current?.workspace.id === selected && Boolean(current?.executionLocation) && current.locationValidation.status === 'ready'
  return <section className="harness-workspace-evidence" aria-label="Workspace App MCP">
    <div className="harness-section-heading"><h4>Workspace App MCP</h4></div>
    <Combobox label="Workspace" value={selected} options={choices} onValueChange={setSelected} placeholder="Search your workspaces…" />
    {workspaces.isPending ? <p role="status">Loading workspaces…</p> : null}
    {workspaces.isError ? <Alert tone="danger" title={workspaces.error.message} action={<Button size="sm" onClick={() => void workspaces.refetch()}>Retry</Button>} /> : null}
    {workspaces.isSuccess && choices.length === 0 ? <p className="harness-muted">Create a workspace and set its execution folder to check App MCP.</p> : null}
    {!selected && choices.length ? <p className="harness-muted">Choose a workspace to check its runner connection.</p> : null}
    {selected && workspace.isPending ? <p role="status">Checking the workspace location…</p> : null}
    {selected && workspace.isError ? <Alert tone="danger" title={workspace.error.message} /> : null}
    {selected && current && !ready ? <p className="harness-muted">Set an accessible local execution folder in Workspace settings.</p> : null}
    {ready ? <div className="harness-evidence-grid">{(harness ? [harness] : ['codex', 'opencode'] as const).map((provider) => <Detection key={`${selected}-${provider}`} workspaceId={selected} harness={provider} />)}</div> : null}
  </section>
}
export function McpDetectionSettings(props: { workspaceId?: string; harness?: 'codex' | 'opencode' }) {
  const epoch = useHarnessSessionEpoch()
  return <WorkspaceEvidence key={`${props.workspaceId ?? 'global'}:${epoch}`} {...props} />
}
