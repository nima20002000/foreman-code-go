import { useId, useState } from 'react'
import { changeCodexSandbox, type CodexHarnessConfiguration, type HarnessConfiguration } from '@foreman-code/contracts'
import { Alert, Button, Combobox, ConfirmDialog, Select, Switch } from '../../shared/ui/nocturne'
import { useNativeHarnessOptions, useRefreshNativeHarness } from '../../shared/api/harnessSettings'
import { fieldMessage, type FieldIssue } from './fieldValidation'
import { ClaudeConfigurationFields } from './ClaudeConfigurationFields'
import { nativeOptionsWithSaved, selectNativeModel, supportedEfforts } from './harnessModelSelection'
import './harnessModelFields.css'

type Props = { value: HarnessConfiguration; onChange(value: HarnessConfiguration): void; issues?: readonly FieldIssue[] }
export function HarnessBasicFields({ value, onChange, issues = [], includeSandbox = true, qualified = false, checking = false, checkError }: Props & { includeSandbox?: boolean; qualified?: boolean; checking?: boolean; checkError?: string }) {
  const query = useNativeHarnessOptions(value.harness)
  const refresh = useRefreshNativeHarness(value.harness)
  const selected = query.data?.models.find((item) => item.id === value.model)
  const models: Array<{ value: string; label: string; description: string; disabled?: boolean }> = query.data?.models.map((item) => ({ value: item.id, label: item.name || item.id, description: item.id })) ?? []
  if (!models.some((item) => item.value === value.model)) models.unshift({ value: value.model, label: value.model,
    description: query.isPending ? 'Loading native models…' : 'Saved model · not in the native catalog', disabled: true })
  if (value.harness === 'claude') return <ClaudeConfigurationFields value={value} onChange={onChange}
    models={query.data?.models ?? []} qualified={qualified} pending={checking || query.isPending}
    error={checkError ?? (refresh.error ?? query.error)?.message} issues={issues} />
  return <div className="harness-basic-fields">
    <div className="harness-model-settings">
      <div className="harness-model-fields">
        <Combobox label="Model" value={value.model} options={models} error={fieldMessage(issues, 'model')}
          onValueChange={(id) => { const model = query.data?.models.find((item) => item.id === id); if (model) onChange(selectNativeModel(value, model)) }} />
        {value.harness === 'codex' ? <Select label="Effort" value={value.reasoningEffort} aria-label="Effort" error={fieldMessage(issues, 'reasoningEffort')}
          options={nativeOptionsWithSaved(supportedEfforts(selected), value.reasoningEffort)}
          onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })} />
          : <Select label="Provider variant" value={value.variant} error={fieldMessage(issues, 'variant')}
            options={nativeOptionsWithSaved(selected ? ['', ...selected.variants] : [], value.variant)} onChange={(event) => onChange({ ...value, variant: event.target.value })} />}
      </div>
      <div className="harness-model-toggles"><HarnessModelOptions value={value} onChange={onChange} issues={issues} /></div>
    </div>
    {query.isPending ? <span className="harness-status" role="status">Loading native models…</span> : null}
    {query.isError || refresh.isError ? <Alert live tone="danger" title={(refresh.error ?? query.error)?.message ?? 'Model discovery failed.'}
      action={<Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Retry</Button>} /> : null}
    {value.harness === 'codex' && includeSandbox ? <div className="harness-model-secondary"><HarnessSandboxField value={value} onChange={onChange} issues={issues} /></div> : null}
    {value.harness === 'opencode' ? <div className="harness-model-secondary">
      <Select label="Native Agent" value={value.nativeAgent} error={fieldMessage(issues, 'nativeAgent')}
        options={nativeOptionsWithSaved(query.data?.nativeAgents ?? [], value.nativeAgent)} onChange={(event) => onChange({ ...value, nativeAgent: event.target.value })} />
    </div> : null}
  </div>
}
function HarnessModelOptions({ value, onChange, issues = [] }: Props) {
  const query = useNativeHarnessOptions(value.harness)
  const errorId = useId()
  if (value.harness === 'opencode') return <Switch label="Show thinking" checked={value.thinking} onChange={(event) => onChange({ ...value, thinking: event.target.checked })} />
  if (value.harness !== 'codex') return null
  const supported = query.data?.models.find((item) => item.id === value.model)?.serviceTiers.includes('priority') === true
  const error = fieldMessage(issues, 'serviceTier') ?? (query.isSuccess && !supported && value.serviceTier === 'priority' ? 'Not offered by this model. Turn Fast mode off.' : undefined)
  return <div className="harness-model-toggle"><Switch label="Fast mode" checked={value.serviceTier === 'priority'} disabled={!supported && value.serviceTier !== 'priority'}
    aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
    onChange={(event) => onChange({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />
    {error ? <span className="n-field-error" id={errorId}>{error}</span> : null}
  </div>
}

export function HarnessSandboxField({ value, onChange, issues = [] }: {
  value: CodexHarnessConfiguration; onChange(value: HarnessConfiguration): void; issues?: readonly FieldIssue[];
}) {
  const [fullAccess, setFullAccess] = useState(false)
  return <div className="harness-sandbox-field">
      <Select label="Sandbox" value={value.sandbox} aria-label="Sandbox" error={fieldMessage(issues, 'sandbox')}
        options={[{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' },
          { value: 'danger-full-access', label: 'Full access · no sandbox' }]}
        onChange={(event) => {
          if (event.target.value === 'danger-full-access' && value.sandbox !== 'danger-full-access') setFullAccess(true)
          else onChange(changeCodexSandbox(value, event.target.value as typeof value.sandbox))
        }} />
      {value.sandbox === 'danger-full-access' ? <span className="harness-access-warning">Commands are not restricted by the Codex sandbox.</span> : null}
    <ConfirmDialog open={fullAccess} onOpenChange={setFullAccess} title="Allow full access?" description="Codex commands will run without its filesystem or network sandbox. This does not change approval routing."
      confirmation="full access" confirmLabel="Use full access" onConfirm={() => {
        if (value.harness === 'codex') onChange(changeCodexSandbox(value, 'danger-full-access'))
        setFullAccess(false)
      }} />
  </div>
}
