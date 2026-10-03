import { WORKER_EXECUTION_STARTUP_VARIABLE } from '@graphql/contracts/management'
import { useWorkerExecutionSettings } from '../../shared/api/workerExecution'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'

export function WorkerExecutionSettings() {
  const settings = useWorkerExecutionSettings()

  return <section aria-labelledby="worker-execution-heading">
    <h2 id="worker-execution-heading" className="computers-title">Laptop and worker execution</h2>
    {settings.isPending ? <LoadingState label="Loading execution setting…" /> : null}
    {settings.isError ? <>
      <Alert tone="danger" title="The execution setting could not be read." />
      <Button onClick={() => void settings.refetch()}>Retry execution setting</Button>
    </> : null}
    {settings.data ? <>
      <p className="computer-hint"><strong>{settings.data.enabled ? 'On' : 'Off'}</strong>
        {' · '}Controls new workflow steps and Jobs on all connected Worker computers.</p>
      <p className="computer-hint">Main execution stays available. Existing work can still be stopped and cleaned up.</p>
      <p className="computer-hint">A person controls this setting on Main at startup. To enable it, set{' '}
        <code>{WORKER_EXECUTION_STARTUP_VARIABLE}=1</code> and restart Main. It cannot be changed here or through MCP.</p>
    </> : null}
  </section>
}
