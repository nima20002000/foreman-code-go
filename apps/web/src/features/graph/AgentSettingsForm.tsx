import { useEffect, useId, useRef, useState } from 'react'
import {
  CodexSessionCompatibilitySchema, DEFAULT_HARNESS_DEFAULTS, changeCodexSandbox, legacyEffortForHarness,
  validateHarnessWorkflowCompatibility, withAdvancedDefaults,
  type Agent, type ApprovalHandler, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@graphql/contracts'

import { Alert, Button, Checkbox, Icon, IconButton, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { CODEX_MODELS, OPENCODE_MODELS, configuredHarness, initialModel } from '../agents/agentSettings'
import { useHarnessDefaultsQuery } from '../../shared/api/query'
import { HarnessConfigurationFields } from '../settings/HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor, switchHarnessEditor } from '../settings/harnessEditor'
import { FieldValidationError, fieldMessage, focusFirstInvalid, issuesAt, validationIssues, type FieldIssue } from '../settings/fieldValidation'
import './agentSettingsPanel.css'

export function AgentSettingsForm({ agent, initialPrompt, creationDefaults, onClose, onRemove, onSave,
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 }, workspaceId, workflowApprovalHandler,
}: {
  agent: Agent
  initialPrompt?: string
  creationDefaults?: HarnessDefaults
  onClose(): void
  onRemove?(): void
  onSave(agent: Agent, initialPrompt: string | undefined, executionPolicy: WorkflowExecutionPolicy): void
  executionPolicy?: WorkflowExecutionPolicy
  workflowNodeCount?: number
  workspaceId?: string
  workflowApprovalHandler?: ApprovalHandler
}) {
  const [name, setName] = useState(agent.name)
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const [error, setError] = useState<string>()
  const [issues, setIssues] = useState<FieldIssue[]>([])
  const [view, setView] = useState<'general' | 'advanced'>('general')
  const root = useRef<HTMLDivElement>(null)
  const modelListId = useId()
  useEffect(() => { if (issues.length) focusFirstInvalid(root.current) }, [issues])
  const [editor, setEditor] = useState(() => {
    const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? 'codex'
    return createHarnessEditor(agent.harnessConfiguration ?? configuredHarness(agent, harness,
      initialModel(agent, harness), agent.effort ?? 'medium', agent.fastMode ?? false, 'read-only', creationDefaults))
  })
  const initialSnapshot = useRef<string | undefined>(undefined)
  if (!initialSnapshot.current) initialSnapshot.current = JSON.stringify({ name: agent.name, prompt: initialPrompt ?? '', editor })
  const defaultsQuery = useHarnessDefaultsQuery({ enabled: !creationDefaults })
  const providerDefaults = creationDefaults ?? defaultsQuery.data?.defaults
  const configuration = withAdvancedDefaults(editor.configuration)
  const currentSnapshot = JSON.stringify({ name, prompt, editor })
  const isDirty = currentSnapshot !== initialSnapshot.current
  const nameError = fieldMessage(issues, 'name')
  const clearErrors = () => { setError(undefined); setIssues([]) }
  const updateConfiguration = (next: typeof configuration) => {
    setEditor((current) => ({ ...current, configuration: next }))
    clearErrors()
  }
  const save = () => {
    try {
      if (!name.trim()) throw new FieldValidationError([{ path: ['name'], message: 'Enter an agent name.' }])
      const nextConfiguration = (() => {
        try {
          const next = prepareHarnessEditor(editor)
          validateHarnessWorkflowCompatibility(next, workflowApprovalHandler)
          if (next.harness === 'codex' && workflowApprovalHandler) CodexSessionCompatibilitySchema.parse({ configuration: next, requiresResume: true })
          return next
        } catch (failure) {
          const harnessIssues = validationIssues(failure)
          if (harnessIssues.length) throw new FieldValidationError(harnessIssues.map((issue) => ({ ...issue,
            path: ['harness', ...(issue.path[0] === 'configuration' ? issue.path.slice(1) : issue.path)] })))
          throw failure
        }
      })()
      onSave({ ...agent, name: name.trim(), harness: nextConfiguration.harness, model: nextConfiguration.model,
        effort: legacyEffortForHarness(nextConfiguration), fastMode: nextConfiguration.harness === 'codex' ? nextConfiguration.serviceTier === 'priority' : undefined,
        harnessConfiguration: nextConfiguration,
      }, prompt.trim() || undefined, executionPolicy)
    } catch (failure) {
      const nextIssues = validationIssues(failure)
      setIssues(nextIssues)
      setError(nextIssues.length ? 'Review the marked fields before saving.' : failure instanceof Error ? failure.message : 'Agent settings are invalid.')
    }
  }
  return <div ref={root} className="agent-settings-panel">
    <header className="agent-settings-heading">
      <div className="agent-settings-title">
        {view === 'advanced' ? <IconButton size="sm" variant="ghost" className="agent-settings-back" label="Back to general settings" onClick={() => setView('general')}><Icon name="chevron" size={15} /></IconButton> : null}
        <strong>{view === 'advanced' ? 'Advanced settings' : 'Agent settings'}</strong>
      </div>
      <div className="agent-settings-header-actions">
      <Button size="sm" variant="primary" className="agent-settings-save" aria-label="Save agent settings" disabled={!isDirty} onClick={save} leading={<Icon name="check" size={13} />}>Save</Button>
      <IconButton size="sm" variant="ghost" label="Close agent settings" onClick={onClose}><Icon name="close" size={15} /></IconButton>
      </div>
    </header>
    {view === 'general' ? <div className="agent-settings-general">
      <div className="agent-settings-row agent-settings-row-primary">
        <TextField label="Name" aria-label="Name" value={name} error={nameError} onChange={(event) => { setName(event.target.value); clearErrors() }} />
        <Select label="Harness" aria-label="Harness" value={configuration.harness} options={[{ value: 'codex', label: 'Codex' }, { value: 'opencode', label: 'OpenCode' }]} onChange={(event) => {
          const next = event.target.value as 'codex' | 'opencode'
          const fallback = providerDefaults?.[next] ?? DEFAULT_HARNESS_DEFAULTS[next]
          setEditor((current) => switchHarnessEditor(current, next, fallback))
          clearErrors()
        }} />
      </div>
      <div className={`agent-settings-row agent-settings-row-runtime agent-settings-row-${configuration.harness}`}>
        <TextField label="Model" aria-label="Model" list={modelListId} value={configuration.model} onChange={(event) => updateConfiguration({ ...configuration, model: event.target.value })} />
        <datalist id={modelListId}>{(configuration.harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS).map((model) => <option key={model} value={model} />)}</datalist>
        {configuration.harness === 'codex' ? <>
          <Select label="Effort" aria-label="Effort" value={configuration.reasoningEffort} options={['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ value: effort, label: effort }))} onChange={(event) => updateConfiguration({ ...configuration, reasoningEffort: event.target.value as typeof configuration.reasoningEffort })} />
          <Select label="Sandbox" aria-label="Sandbox" className="agent-settings-sandbox" value={configuration.sandbox} options={[{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' }, { value: 'danger-full-access', label: 'Danger: full access' }]} onChange={(event) => updateConfiguration(changeCodexSandbox(configuration, event.target.value as typeof configuration.sandbox))} />
        </> : <>
          <TextField label="Provider variant" aria-label="Provider variant" value={configuration.variant} onChange={(event) => updateConfiguration({ ...configuration, variant: event.target.value })} />
          <Checkbox label="Show thinking" aria-label="Show thinking" className="agent-settings-thinking" checked={configuration.thinking} onChange={(event) => updateConfiguration({ ...configuration, thinking: event.target.checked })} />
        </>}
      </div>
    </div> : <div className="agent-settings-advanced-view">
      <Textarea label="Initial prompt" aria-label="Initial prompt" className="agent-settings-prompt" rows={3} value={prompt} onChange={(event) => { setPrompt(event.target.value); clearErrors() }} />
      <HarnessConfigurationFields editor={editor} issues={issuesAt(issues, ['harness'])} onChange={(next) => { setEditor(next); clearErrors() }} allowHarnessChange={false} harnessDefaults={providerDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} compact advancedOnly />
      <p className="settings-help">Save updates this graph draft. Use Save graph to persist it.</p>
    </div>}
    {error ? <Alert tone="danger" live title={error} /> : null}
    <footer className="agent-settings-footer">
      {view === 'general' ? <Button size="sm" variant="ghost" className="agent-settings-advanced-link" onClick={() => setView('advanced')} trailing={<Icon name="chevron" size={13} />}>Advanced settings</Button> : null}
      {view === 'general' && configuration.harness === 'codex' ? <Checkbox label="Fast mode" aria-label="Fast mode" className="agent-settings-fast-mode" checked={configuration.serviceTier === 'priority'} onChange={(event) => updateConfiguration({ ...configuration, serviceTier: event.target.checked ? 'priority' : 'standard' })} /> : null}
      {onRemove ? <IconButton size="sm" variant="ghost" className="agent-settings-trash" label={`Remove ${agent.name} from workflow`} onClick={onRemove}><Icon name="minus" size={15} /></IconButton> : null}
    </footer>
  </div>
}
