import type { OperatorChatSetup } from '@foreman-code/contracts'
import { ExecutionReadinessNotice } from './ExecutionReadinessNotice'
import { Alert, Button } from '../../shared/ui/nocturne'

export function OperatorSetupNotice({ data, checking, failed, onRetry }: {
  data?: OperatorChatSetup; checking: boolean; failed: boolean; onRetry(): void;
}) {
  if (checking && !data) return <p role="status">Checking Foreman Code MCP installation…</p>
  if (failed) return <details><summary>Tool connection check failed</summary>
    <p>{data?.status === 'configured' ? 'The connection was configured at the last successful check.'
      : 'Check the tool connection before sending a message.'}</p>
    <Button size="sm" disabled={checking} onClick={onRetry}>Check again</Button>
  </details>
  if (!data) return null
  if (data.harness === 'opencode') return <p role="status">Retired harness (OpenCode): read-only</p>
  if (data.status === 'configured') return <ExecutionReadinessNotice harness={data.harness} configurationVersionId={data.configurationVersionId} />
  const name = data.harness === 'claude' ? 'Claude' : 'Codex'
  return <Alert tone="warning" title={`Install Foreman Code MCP in ${name} first`}
    action={<><a className="n-button n-button--secondary n-button--sm"
      href={`/settings/harnesses?harness=${data.harness}&section=connections`}>Open Harness Settings</a>
      <Button size="sm" disabled={checking} loading={checking} onClick={onRetry}>Check again</Button></>}>
    <p>{data.reason ?? "Operator chat needs the enabled Foreman Code MCP connection to use the app’s tools."}</p>
    <p>Add Foreman Code MCP for {name} in Harness Settings, then check again. The same connection serves workflow agents; no token entry is needed.</p>
  </Alert>
}
