import type { McpDetection } from '@graphql/contracts'
import { PlugZap } from 'lucide-react'

import { useMcpDetectionQuery } from '../../shared/api/query'
import { Alert, Button, Card, CardBody, CardHeader, Icon, LoadingState, StatusBadge } from '../../shared/ui/nocturne'
import type { IconName, Tone } from '../../shared/ui/nocturne'
import './settingsUsability.css'

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

const tones: Record<McpDetection['state'], Tone> = {
  not_detected: 'neutral',
  misconfigured: 'warning',
  status_unavailable: 'info',
  connected: 'success',
  disabled: 'neutral',
  authentication_required: 'warning',
  broken: 'danger',
  check_failed: 'danger',
}

const stateIcons: Record<McpDetection['state'], IconName> = {
  not_detected: 'warning',
  misconfigured: 'warning',
  status_unavailable: 'info',
  connected: 'check',
  disabled: 'warning',
  authentication_required: 'warning',
  broken: 'warning',
  check_failed: 'warning',
}

function DetectionCard({ workspaceId, harness }: { workspaceId: string; harness: 'codex' | 'opencode' }) {
  const query = useMcpDetectionQuery(workspaceId, harness)
  const name = harness === 'codex' ? 'Codex' : 'OpenCode'
  if (query.isPending) return <Card><CardHeader title={name} /><CardBody><LoadingState label={`Checking ${name}…`} /></CardBody></Card>
  if (query.isError) return <Card>
    <CardHeader title={name} action={<Icon name="warning" size={17} />} />
    <CardBody className="mcp-detection-card-body">
      <Alert tone="danger" title="Check failed" action={<Button onClick={() => void query.refetch()}>Retry</Button>}>{query.error.message}</Alert>
    </CardBody>
  </Card>
  const value = query.data
  const state = value.detection.state
  return <Card>
    <CardHeader title={name} description={`${value.providerVersion} · ${value.runnerId}`} action={<Icon name={stateIcons[state]} size={17} />} />
    <CardBody className="mcp-detection-card-body">
      <StatusBadge label={labels[state]} tone={tones[state]} />
      <p>{help[state]}</p>
      {value.detection.detail ? <p>{value.detection.detail}</p> : null}
      <dl className="mcp-detection-details"><div><dt>Workspace path</dt><dd>{value.workingDirectory}</dd></div><div><dt>Checked</dt><dd>{new Date(value.detection.checkedAt).toLocaleString()}</dd></div></dl>
      {(value.nativeFilters.enabledTools?.length || value.nativeFilters.disabledTools?.length || value.nativeFilters.diagnostics?.length) ? <details><summary>Native filter diagnostics</summary>
        {value.nativeFilters.enabledTools?.length ? <p>Enabled: {value.nativeFilters.enabledTools.join(', ')}</p> : null}
        {value.nativeFilters.disabledTools?.length ? <p>Disabled: {value.nativeFilters.disabledTools.join(', ')}</p> : null}
        {value.nativeFilters.diagnostics?.map((item) => <p key={item}>{item}</p>)}
      </details> : null}
      {state !== 'connected' ? <p className="mcp-manual-help"><PlugZap size={15} />Inspect the effective native MCP configuration on this exact runner and workspace. GraphQL will not rewrite it automatically.</p> : null}
    </CardBody>
  </Card>
}

export function McpDetectionSettings({ workspaceId }: { workspaceId: string }) {
  return <Card role="region" aria-label="App MCP detection">
    <CardHeader eyebrow="Read-only evidence" title="App MCP detection" description="Status is scoped to this workspace’s accepted runner and working directory." />
    <CardBody><div className="mcp-detection-grid"><DetectionCard workspaceId={workspaceId} harness="codex" /><DetectionCard workspaceId={workspaceId} harness="opencode" /></div></CardBody>
  </Card>
}
