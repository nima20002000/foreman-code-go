import type { McpDetection } from '@graphql/contracts'
import { AlertTriangle, CheckCircle2, CircleHelp, PlugZap } from 'lucide-react'

import { useMcpDetectionQuery } from '../../shared/api/query'

const labels: Record<McpDetection['state'], string> = {
  not_detected: 'Not detected',
  misconfigured: 'Misconfigured',
  status_unavailable: 'Detected · status unavailable',
  connected: 'Detected · connected',
  disabled: 'Detected · disabled',
  authentication_required: 'Detected · authentication required',
  broken: 'Detected · broken',
  check_failed: 'Check failed',
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

function DetectionCard({ workspaceId, harness }: { workspaceId: string; harness: 'codex' | 'opencode' }) {
  const query = useMcpDetectionQuery(workspaceId, harness)
  if (query.isPending) return <article className="mcp-detection-card"><p role="status">Checking {harness === 'codex' ? 'Codex' : 'OpenCode'}…</p></article>
  if (query.isError) return <article className="mcp-detection-card mcp-state-check_failed"><header><AlertTriangle size={17} /><h3>{harness === 'codex' ? 'Codex' : 'OpenCode'}</h3></header><strong>Check failed</strong><p>{query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Retry</button></article>
  const value = query.data
  const state = value.detection.state
  const GoodIcon = state === 'connected' ? CheckCircle2 : state === 'status_unavailable' ? CircleHelp : AlertTriangle
  return <article className={`mcp-detection-card mcp-state-${state}`}>
    <header><GoodIcon size={17} /><div><h3>{harness === 'codex' ? 'Codex' : 'OpenCode'}</h3><small>{value.providerVersion} · {value.runnerId}</small></div></header>
    <strong>{labels[state]}</strong>
    <p>{help[state]}</p>
    {value.detection.detail ? <p className="mcp-detection-detail">{value.detection.detail}</p> : null}
    <dl><div><dt>Workspace path</dt><dd>{value.workingDirectory}</dd></div><div><dt>Checked</dt><dd>{new Date(value.detection.checkedAt).toLocaleString()}</dd></div></dl>
    {(value.nativeFilters.enabledTools?.length || value.nativeFilters.disabledTools?.length || value.nativeFilters.diagnostics?.length) ? <details><summary>Native filter diagnostics</summary>
      {value.nativeFilters.enabledTools?.length ? <p>Enabled: {value.nativeFilters.enabledTools.join(', ')}</p> : null}
      {value.nativeFilters.disabledTools?.length ? <p>Disabled: {value.nativeFilters.disabledTools.join(', ')}</p> : null}
      {value.nativeFilters.diagnostics?.map((item) => <p key={item}>{item}</p>)}
    </details> : null}
    {state !== 'connected' ? <p className="mcp-manual-help"><PlugZap size={15} />Inspect the effective native MCP configuration on this exact runner and workspace. GraphQL will not rewrite it automatically.</p> : null}
  </article>
}

export function McpDetectionSettings({ workspaceId }: { workspaceId: string }) {
  return <section className="settings-form mcp-detection-settings" aria-labelledby="mcp-detection-title">
    <header className="settings-form-heading"><div><p className="panel-kicker">Read-only evidence</p><h2 id="mcp-detection-title">App MCP detection</h2><p>Status is scoped to this workspace’s accepted runner and working directory.</p></div></header>
    <div className="mcp-detection-grid"><DetectionCard workspaceId={workspaceId} harness="codex" /><DetectionCard workspaceId={workspaceId} harness="opencode" /></div>
  </section>
}
