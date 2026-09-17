import { useState } from 'react'
import { changeCodexSandbox, type HarnessConfiguration } from '@graphql/contracts'
import { Alert, Button, Checkbox, Combobox, ConfirmDialog, Select } from '../../shared/ui/nocturne'
import { useNativeHarnessOptions, useRefreshNativeHarness } from '../../shared/api/harnessSettings'
import { fieldMessage, type FieldIssue } from './fieldValidation'
import { nativeOptionsWithSaved, selectNativeModel, supportedEfforts } from './harnessModelSelection'

type Props = { value: HarnessConfiguration; onChange(value: HarnessConfiguration): void; issues?: readonly FieldIssue[] }
export function HarnessBasicFields({ value, onChange, issues = [] }: Props) {
  const query = useNativeHarnessOptions(value.harness)
  const refresh = useRefreshNativeHarness(value.harness)
  const [fullAccess, setFullAccess] = useState(false)
  const selected = query.data?.models.find((item) => item.id === value.model)
  const models: Array<{ value: string; label: string; description: string; disabled?: boolean }> = query.data?.models.map((item) => ({ value: item.id, label: item.name || item.id, description: item.id })) ?? []
  if (!models.some((item) => item.value === value.model)) models.unshift({ value: value.model, label: value.model,
    description: query.isPending ? 'Loading native models…' : 'Saved model · not in the native catalog', disabled: true })
  return <div className="harness-basic-fields">
    <Combobox label="Model" value={value.model} options={models} error={fieldMessage(issues, 'model')}
      onValueChange={(id) => { const model = query.data?.models.find((item) => item.id === id); if (model) onChange(selectNativeModel(value, model)) }} />
    {query.isPending ? <span className="harness-status" role="status">Loading native models…</span> : null}
    {query.isError || refresh.isError ? <Alert live tone="danger" title={(refresh.error ?? query.error)?.message ?? 'Model discovery failed.'}
      action={<Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Retry</Button>} /> : null}
    {value.harness === 'codex' ? <div className="harness-two-columns">
      <Select label="Effort" value={value.reasoningEffort} aria-label="Effort" error={fieldMessage(issues, 'reasoningEffort')}
        options={nativeOptionsWithSaved(supportedEfforts(selected), value.reasoningEffort)}
        onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value as typeof value.reasoningEffort })} />
      <Select label="Sandbox" value={value.sandbox} aria-label="Sandbox" error={fieldMessage(issues, 'sandbox')}
        hint="Leaving workspace-write removes additional writable directories and workspace-write options."
        options={[{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' },
          { value: 'danger-full-access', label: 'Full access · no sandbox' }]}
        onChange={(event) => {
          if (event.target.value === 'danger-full-access' && value.sandbox !== 'danger-full-access') setFullAccess(true)
          else onChange(changeCodexSandbox(value, event.target.value as typeof value.sandbox))
        }} />
      {value.sandbox === 'danger-full-access' ? <span className="harness-access-warning">Commands are not restricted by the Codex sandbox.</span> : null}
    </div> : <div className="harness-two-columns">
      <Select label="Provider variant" value={value.variant} error={fieldMessage(issues, 'variant')}
        options={nativeOptionsWithSaved(selected ? ['', ...selected.variants] : [], value.variant)} onChange={(event) => onChange({ ...value, variant: event.target.value })} />
      <Select label="Native Agent" value={value.nativeAgent} error={fieldMessage(issues, 'nativeAgent')}
        options={nativeOptionsWithSaved(query.data?.nativeAgents ?? [], value.nativeAgent)} onChange={(event) => onChange({ ...value, nativeAgent: event.target.value })} />
    </div>}
    <ConfirmDialog open={fullAccess} onOpenChange={setFullAccess} title="Allow full access?" description="Codex commands will run without its filesystem or network sandbox. This does not change approval routing."
      confirmation="full access" confirmLabel="Use full access" onConfirm={() => {
        if (value.harness === 'codex') onChange(changeCodexSandbox(value, 'danger-full-access'))
        setFullAccess(false)
      }} />
  </div>
}
export function HarnessFooterOptions({ value, onChange, issues = [] }: Props) {
  const query = useNativeHarnessOptions(value.harness)
  if (value.harness === 'opencode') return <Checkbox label="Show thinking" checked={value.thinking} onChange={(event) => onChange({ ...value, thinking: event.target.checked })} />
  const supported = query.data?.models.find((item) => item.id === value.model)?.serviceTiers.includes('priority') === true
  return <Checkbox label="Fast mode" checked={value.serviceTier === 'priority'} disabled={!supported && value.serviceTier !== 'priority'}
    error={fieldMessage(issues, 'serviceTier') ?? (query.isSuccess && !supported && value.serviceTier === 'priority' ? 'Not offered by this model. Turn Fast mode off.' : undefined)}
    onChange={(event) => onChange({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />
}
