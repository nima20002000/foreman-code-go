import { useRemoteExecutionSettings } from '../../shared/api/remoteExecutionSettings'

export function RemoteExecutionSummary() {
  const query = useRemoteExecutionSettings()
  if (query.isError) return <small>Remote execution status unavailable · change via Operator</small>
  if (!query.data) return <small>Loading remote execution status…</small>
  const { effective, environmentOverrides, runtime } = query.data
  const listener = runtime.listenerEndpoint ?? effective.listener.advertisedEndpoint ?? 'URL unconfigured'
  return <small>
    Listener: {listener} ({runtime.listenerEnabled ? 'on' : 'off'}) · Remote execution: {effective.enabled ? 'on' : 'off'}
    {environmentOverrides.length > 0 ? ' · environment overrides' : ''}
    {runtime.restartRequired ? ' · restart Main to apply listener changes' : ''}
    {' · change via Operator'}
  </small>
}
