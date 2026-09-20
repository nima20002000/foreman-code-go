import type { OperatorChatSetup } from '@graphql/contracts'
import { Alert, Button } from '../../shared/ui/nocturne'

export function OperatorSetupNotice({ data, checking, failed, onRetry }: {
  data?: OperatorChatSetup; checking: boolean; failed: boolean; onRetry(): void;
}) {
  if (checking && !data) return <p role="status">Checking Operator MCP installation…</p>
  if (failed) return <Alert tone="warning" title="Operator MCP could not be checked"
    action={<Button size="sm" disabled={checking} onClick={onRetry}>Check again</Button>}>Chat is unavailable until the installation is verified.</Alert>
  if (!data || data.status === 'configured') return null
  const name = data.harness === 'opencode' ? 'OpenCode' : 'Codex'
  return <Alert tone="warning" title={`Install Operator MCP in ${name} first`}
    action={<><a className="n-button n-button--secondary n-button--sm"
      href={`/settings/harnesses?harness=${data.harness}&section=connections`}>Open Harness Settings</a>
      <Button size="sm" disabled={checking} loading={checking} onClick={onRetry}>Check again</Button></>}>
    <p>{data.reason ?? "Operator chat needs the enabled graphql-operator connection to use the app’s tools."}</p>
    <p>Add Operator MCP for {name} in Harness Settings, then check again. No token entry is needed.</p>
  </Alert>
}
