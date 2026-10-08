import { retiredHarnessLabel } from './settingsPresentation'
import { useId } from 'react'
import { CLAUDE_FULL_ACCESS_REQUIRED } from '@foreman-code/contracts/claude'
import { claudeAccessOptions } from './claudeAccess'
import { AgentEffortSchema, withAdvancedDefaults, type HarnessConfiguration } from '@foreman-code/contracts'
import { Select, Switch, Textarea, TextField } from '../../shared/ui/nocturne'
import { HarnessSectionFields } from './HarnessSectionFields'
import { HarnessTokenList } from './HarnessTokenList'
import type { HarnessEditor } from './harnessEditor'
import { fieldMessage, type FieldIssue } from './fieldValidation'
import { ClaudeMcpConfiguration } from './ClaudeMcpConfiguration'
import './harnessModelFields.css'

/** Configuration editing is passive. Native catalogs/checks are never queried on the API host. */
function EditableHostHarnessConfigurationFields({ editor, onChange, issues }: {
  editor: HarnessEditor; onChange(editor: HarnessEditor): void; issues?: readonly FieldIssue[];
}) {
  const serviceTierErrorId = useId()
  const serviceTierError = fieldMessage(issues ?? [], 'serviceTier')
  const value = withAdvancedDefaults(editor.configuration)
  const change = (configuration: HarnessConfiguration) => onChange({ ...editor, configuration })
  if (value.harness === 'opencode') return null
  if (value.harness === 'claude') return <div className="harness-form-stack">
    <TextField className="harness-model-secondary" label="Model" value={value.model} error={fieldMessage(issues ?? [], 'model')}
      onChange={event => change({ ...value, model: event.target.value })} />
    <TextField label="Local Claude profile directory" value={value.configDirectory} error={fieldMessage(issues ?? [], 'configDirectory')}
      hint="Sign in on this computer using this profile." onChange={event => change({ ...value, configDirectory: event.target.value })} />
    <Select label="Authentication" value={value.authMode} error={fieldMessage(issues ?? [], 'authMode')}
      options={[{ value: 'subscription', label: 'Local Claude subscription login' }, { value: 'api-key', label: 'Explicit API key · separate billing' }]}
      onChange={event => change({ ...value, authMode: event.target.value as typeof value.authMode })} />
    <Select label="Sandbox" value={value.sandbox} error={fieldMessage(issues ?? [], 'sandbox') ?? (value.sandbox !== 'danger-full-access' ? CLAUDE_FULL_ACCESS_REQUIRED : undefined)}
      options={claudeAccessOptions(value.sandbox)}
      onChange={event => change({ ...value, sandbox: event.target.value as typeof value.sandbox })} />
    <p>These are explicit configuration values. Saving does not discover models, install, sign in or qualify a harness. Use the saved profile check on this computer.</p>
    <h4>Access and approvals</h4>
    <p>Tool approvals use app routing. Enabled tools: {value.tools.join(', ') || 'None'}</p>
    {value.permissionRules.map(rule => <p key={rule.tool}>{rule.tool}: {rule.effect}</p>)}
    <h4>Session behavior</h4><p>Accepted instructions: {value.instructions || 'None'}</p>
    <h4>Pinned MCP policy</h4>
    <ClaudeMcpConfiguration value={value} onChange={change} appPreset={false} />
  </div>
  return <div className="harness-form-stack">
    <div className="harness-model-settings">
      <div className="harness-model-fields">
        <TextField label="Model" value={value.model} error={fieldMessage(issues ?? [], 'model')} onChange={event => change({ ...value, model: event.target.value })} />
        {value.harness === 'codex' ? <Select label="Effort" value={value.reasoningEffort} error={fieldMessage(issues ?? [], 'reasoningEffort')}
          options={AgentEffortSchema.options.map(item => ({ value: item, label: item }))}
          onChange={event => change({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })} /> : null}
      </div>
      <div className="harness-model-toggles">
        {value.harness === 'codex' ? <div className="harness-model-toggle"><Switch label="Fast mode" checked={value.serviceTier === 'priority'}
          aria-invalid={serviceTierError ? true : undefined} aria-describedby={serviceTierError ? serviceTierErrorId : undefined}
          onChange={event => change({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />
          {serviceTierError ? <span className="n-field-error" id={serviceTierErrorId}>{serviceTierError}</span> : null}</div> : null}
      </div>
    </div>
    <h4>Access and approvals</h4>
    <HarnessSectionFields editor={editor} onChange={onChange} section="permissions" issues={issues}
      writableDirectories={value.harness === 'codex' ? <HarnessTokenList label="Additional writable paths on this computer"
        values={value.advanced!.additionalWritableDirectories} onChange={paths => change({ ...value, advanced: { ...value.advanced!, additionalWritableDirectories: paths } })} /> : undefined} />
    <h4>Session behavior</h4>
    <HarnessSectionFields editor={editor} onChange={onChange} section="session" issues={issues} />
    {value.harness === 'codex' ? <Textarea label="Shell environment policy · JSON" value={editor.shellEnvironmentText}
      error={fieldMessage(issues ?? [], 'advanced.shellEnvironment')}
      hint="Environment policy for this host instance. Native login files and credentials are never copied."
      onChange={event => onChange({ ...editor, shellEnvironmentText: event.target.value })} /> : null}
    <Textarea label="Pinned MCP policy · JSON" value={editor.mcpText}
      error={fieldMessage(issues ?? [], 'advanced.mcpServers')}
      hint="Pinned native configuration requirements only. Editing does not inspect servers or rewrite target connection files."
      onChange={event => onChange({ ...editor, mcpText: event.target.value })} />
  </div>
}

export function HostHarnessConfigurationFields(props: Parameters<typeof EditableHostHarnessConfigurationFields>[0]) {
  if (props.editor.configuration.harness === 'opencode') return <p role="status">{retiredHarnessLabel}</p>
  return <EditableHostHarnessConfigurationFields {...props} />
}
