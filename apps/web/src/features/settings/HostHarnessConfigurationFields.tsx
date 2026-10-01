import { AgentEffortSchema, withAdvancedDefaults, type HarnessConfiguration } from '@graphql/contracts'
import { Checkbox, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { HarnessSectionFields } from './HarnessSectionFields'
import { HarnessTokenList } from './HarnessTokenList'
import type { HarnessEditor } from './harnessEditor'
import { fieldMessage, type FieldIssue } from './fieldValidation'

/** Configuration editing is passive. Native catalogs/checks are never queried on the API host. */
export function HostHarnessConfigurationFields({ editor, onChange, issues }: {
  editor: HarnessEditor; onChange(editor: HarnessEditor): void; issues?: readonly FieldIssue[];
}) {
  const value = withAdvancedDefaults(editor.configuration)
  const change = (configuration: HarnessConfiguration) => onChange({ ...editor, configuration })
  if (value.harness === 'claude') return <div className="harness-form-stack">
    <TextField label="Model" value={value.model} error={fieldMessage(issues ?? [], 'model')}
      onChange={event => change({ ...value, model: event.target.value })} />
    <TextField label="Local Claude profile directory" value={value.configDirectory} error={fieldMessage(issues ?? [], 'configDirectory')}
      hint="Sign in on this computer using this profile." onChange={event => change({ ...value, configDirectory: event.target.value })} />
    <Select label="Authentication" value={value.authMode} error={fieldMessage(issues ?? [], 'authMode')}
      options={[{ value: 'subscription', label: 'Local Claude subscription login' }, { value: 'api-key', label: 'Explicit API key · separate billing' }]}
      onChange={event => change({ ...value, authMode: event.target.value as typeof value.authMode })} />
    <Select label="Sandbox" value={value.sandbox} error={fieldMessage(issues ?? [], 'sandbox')}
      options={[{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' }]}
      onChange={event => change({ ...value, sandbox: event.target.value as typeof value.sandbox })} />
    <p>These are explicit configuration values. Saving does not discover models, install, sign in or qualify a harness. Use the saved profile check on this computer.</p>
    <h4>Access and approvals</h4>
    <p>Tool approvals use app routing. Enabled tools: {value.tools.join(', ') || 'None'}</p>
    {value.permissionRules.map(rule => <p key={rule.tool}>{rule.tool}: {rule.effect}</p>)}
    <h4>Session behavior</h4><p>Accepted instructions: {value.instructions || 'None'}</p>
    <h4>Pinned MCP policy</h4>
    {Object.entries(value.mcpServers).map(([name, server]) => <p key={name}>{name}: {server.url}</p>)}
    {!Object.keys(value.mcpServers).length ? <p>No MCP servers are configured.</p> : null}
  </div>
  return <div className="harness-form-stack">
    <TextField label="Model" value={value.model} onChange={event => change({ ...value, model: event.target.value })} />
    {value.harness === 'codex' ? <>
      <Select label="Effort" value={value.reasoningEffort} options={AgentEffortSchema.options.map(item => ({ value: item, label: item }))}
        onChange={event => change({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })} />
      <Select label="Service tier" value={value.serviceTier} options={[{ value: 'standard', label: 'Standard' }, { value: 'priority', label: 'Priority' }]}
        onChange={event => change({ ...value, serviceTier: event.target.value as typeof value.serviceTier })} />
    </> : <>
      <TextField label="Provider variant" value={value.variant} onChange={event => change({ ...value, variant: event.target.value })} />
      <TextField label="Native Agent" value={value.nativeAgent} onChange={event => change({ ...value, nativeAgent: event.target.value })} />
      <Checkbox label="Show thinking" checked={value.thinking} onChange={event => change({ ...value, thinking: event.target.checked })} />
    </>}
    <p>These are explicit configuration values. Saving does not discover models, install, sign in or qualify a harness. Target-local admission validates provider support.</p>
    <h4>Access and approvals</h4>
    <HarnessSectionFields editor={editor} onChange={onChange} section="permissions" issues={issues}
      writableDirectories={value.harness === 'codex' ? <HarnessTokenList label="Additional writable paths on this computer"
        values={value.advanced!.additionalWritableDirectories} onChange={paths => change({ ...value, advanced: { ...value.advanced!, additionalWritableDirectories: paths } })} /> : undefined} />
    <h4>Session behavior</h4>
    <HarnessSectionFields editor={editor} onChange={onChange} section="session" issues={issues} />
    {value.harness === 'codex' ? <Textarea label="Shell environment policy · JSON" value={editor.shellEnvironmentText}
      hint="Environment policy for this host instance. Native login files and credentials are never copied."
      onChange={event => onChange({ ...editor, shellEnvironmentText: event.target.value })} /> : null}
    <Textarea label="Pinned MCP policy · JSON" value={editor.mcpText}
      hint="Pinned native configuration requirements only. Editing does not inspect servers or rewrite target connection files."
      onChange={event => onChange({ ...editor, mcpText: event.target.value })} />
  </div>
}
