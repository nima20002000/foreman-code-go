import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react'
import {
  CodexSessionCompatibilitySchema, DEFAULT_HARNESS_DEFAULTS, changeCodexSandbox, legacyEffortForHarness,
  validateHarnessWorkflowCompatibility, withAdvancedDefaults,
  type Agent, type ApprovalHandler, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@graphql/contracts'

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
  const nameErrorId = useId()
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
          if (next.harness === 'opencode' && next.autoApprove) throw new FieldValidationError([{ path: ['advanced', 'permissionHandling'], message: 'Native auto approval is not supported by the managed OpenCode server. Select GraphQL routed review.' }])
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
        {view === 'advanced' ? <button type="button" className="agent-settings-back" aria-label="Back to general settings" onClick={() => setView('general')}><ChevronLeft size={15} /></button> : null}
        <strong>{view === 'advanced' ? 'Advanced settings' : 'Agent settings'}</strong>
      </div>
      <div className="agent-settings-header-actions">
      <button type="button" className="agent-settings-save" aria-label="Save agent settings" disabled={!isDirty} onClick={save}><Check size={13} /> Save</button>
      <button type="button" aria-label="Close agent settings" onClick={onClose}><X size={15} /></button>
      </div>
    </header>
    {view === 'general' ? <div className="agent-settings-general">
      <div className="agent-settings-row agent-settings-row-primary">
        <label><span>Name</span><input aria-label="Name" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? nameErrorId : undefined} value={name} onChange={(event) => { setName(event.target.value); clearErrors() }} />{nameError ? <small id={nameErrorId} className="settings-field-error">{nameError}</small> : null}</label>
        <label><span>Harness</span><select aria-label="Harness" value={configuration.harness} onChange={(event) => {
          const next = event.target.value as 'codex' | 'opencode'
          const fallback = providerDefaults?.[next] ?? DEFAULT_HARNESS_DEFAULTS[next]
          setEditor((current) => switchHarnessEditor(current, next, fallback))
          clearErrors()
        }}><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label>
      </div>
      <div className={`agent-settings-row agent-settings-row-runtime agent-settings-row-${configuration.harness}`}>
        <label><span>Model</span><input aria-label="Model" list={modelListId} value={configuration.model} onChange={(event) => updateConfiguration({ ...configuration, model: event.target.value })} /></label>
        <datalist id={modelListId}>{(configuration.harness === 'codex' ? CODEX_MODELS : OPENCODE_MODELS).map((model) => <option key={model} value={model} />)}</datalist>
        {configuration.harness === 'codex' ? <>
          <label><span>Reasoning effort</span><select aria-label="Effort" value={configuration.reasoningEffort} onChange={(event) => updateConfiguration({ ...configuration, reasoningEffort: event.target.value as typeof configuration.reasoningEffort })}>{['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
          <label className="agent-settings-sandbox"><span>Sandbox</span><select aria-label="Sandbox" value={configuration.sandbox} onChange={(event) => updateConfiguration(changeCodexSandbox(configuration, event.target.value as typeof configuration.sandbox))}><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Danger: full access</option></select></label>
        </> : <>
          <label><span>Provider variant</span><input aria-label="Provider variant" value={configuration.variant} onChange={(event) => updateConfiguration({ ...configuration, variant: event.target.value })} /></label>
          <label className="agent-settings-thinking"><span>Show thinking</span><input type="checkbox" aria-label="Show thinking" checked={configuration.thinking} onChange={(event) => updateConfiguration({ ...configuration, thinking: event.target.checked })} /></label>
        </>}
      </div>
    </div> : <div className="agent-settings-advanced-view">
      <label className="agent-settings-prompt">Initial prompt<textarea aria-label="Initial prompt" rows={3} value={prompt} onChange={(event) => { setPrompt(event.target.value); clearErrors() }} /></label>
      <HarnessConfigurationFields editor={editor} issues={issuesAt(issues, ['harness'])} onChange={(next) => { setEditor(next); clearErrors() }} allowHarnessChange={false} harnessDefaults={providerDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} compact advancedOnly />
      <p className="settings-help">Save updates this graph draft. Use Save graph to persist it.</p>
    </div>}
    {error ? <p className="agent-settings-error" role="alert">{error}</p> : null}
    <footer className="agent-settings-footer">
      {view === 'general' ? <button type="button" className="agent-settings-advanced-link" onClick={() => setView('advanced')}>Advanced settings<ChevronRight size={13} /></button> : null}
      {view === 'general' && configuration.harness === 'codex' ? <label className="agent-settings-fast-mode"><span>Fast mode</span><input type="checkbox" aria-label="Fast mode" checked={configuration.serviceTier === 'priority'} onChange={(event) => updateConfiguration({ ...configuration, serviceTier: event.target.checked ? 'priority' : 'standard' })} /><span className="agent-settings-fast-track" aria-hidden="true" /></label> : null}
      {onRemove ? <button type="button" className="agent-settings-trash" aria-label={`Remove ${agent.name} from workflow`} onClick={onRemove}><Trash2 size={15} /></button> : null}
    </footer>
  </div>
}
