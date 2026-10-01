import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { Alert, Combobox, Select, TextField } from '../../shared/ui/nocturne'
import { fieldMessage, type FieldIssue } from './fieldValidation'

type Props = {
  value: ClaudeHarnessConfiguration
  onChange(value: ClaudeHarnessConfiguration): void
  models: readonly { id: string; name?: string }[]
  qualified: boolean
  pending?: boolean
  error?: string
  issues?: readonly FieldIssue[]
}
/** Discovery and saved state are provided by the shared settings query/command owner. */
export function ClaudeConfigurationFields({ value, onChange, models, qualified, pending = false, error, issues = [] }: Props) {
  const options = models.map((model) => ({ value: model.id, label: model.name ?? model.id, description: model.id, disabled: false }))
  if (!options.some((option) => option.value === value.model)) options.unshift({ value: value.model, label: value.model, description: 'Saved model · awaiting native qualification', disabled: true })
  return <div className="harness-basic-fields">
    <Combobox label="Model" value={value.model} options={options} error={fieldMessage(issues, 'model')}
      onValueChange={(model) => { if (models.some((item) => item.id === model)) onChange({ ...value, model }) }} />
    <TextField label="Local Claude profile directory" value={value.configDirectory} error={fieldMessage(issues, 'configDirectory')}
      hint="Sign in on the selected computer using this profile."
      onChange={(event) => onChange({ ...value, configDirectory: event.target.value })} />
    <div className="harness-two-columns">
      <Select label="Authentication" value={value.authMode} error={fieldMessage(issues, 'authMode')}
        options={[{ value: 'subscription', label: 'Local Claude subscription login' }, { value: 'api-key', label: 'Explicit API key · separate billing' }]}
        onChange={(event) => onChange({ ...value, authMode: event.target.value as ClaudeHarnessConfiguration['authMode'] })} />
      <Select label="Sandbox" value={value.sandbox} error={fieldMessage(issues, 'sandbox')}
        options={[{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' }]}
        onChange={(event) => onChange({ ...value, sandbox: event.target.value as ClaudeHarnessConfiguration['sandbox'] })} />
    </div>
    {pending ? <span className="harness-status" role="status">Checking the selected Claude configuration…</span> : null}
    {error ? <Alert tone="danger" live title={error} /> : !qualified && !pending ? <Alert tone="warning" title="Claude is awaiting native qualification" >Save and execution require verified authentication, settings isolation and sandbox support on the selected computer.</Alert> : null}
    <p className="harness-status">Tool approvals use app routing. Native settings, hooks, plugins and agents are excluded from the accepted configuration.</p>
  </div>
}
