import { sameWorkflowValue } from '@graphql/contracts/wave25'
import type { AgentForm } from './nextDraft/agentForm'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useEffect, useRef, useState } from 'react'
import {
  CodexSessionCompatibilitySchema, DEFAULT_HARNESS_DEFAULTS, legacyEffortForHarness,
  validateHarnessWorkflowCompatibility, withAdvancedDefaults,
  type Agent, type ApprovalHandler, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@graphql/contracts'

import { Alert, Button, Icon, IconButton, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { configuredHarness, initialModel } from '../agents/agentSettings'
import { useHarnessDefaultsQuery } from '../../shared/api/query'
import { HarnessConfigurationFields } from '../settings/HarnessConfigurationFields'
import { HarnessBasicFields } from '../settings/HarnessBasicFields'
import { createHarnessEditor, prepareHarnessEditor, switchHarnessEditor } from '../settings/harnessEditor'
import { FieldValidationError, fieldMessage, focusFirstInvalid, issuesAt, validationIssues, type FieldIssue } from '../settings/fieldValidation'
import './agentSettingsPanel.css'

export function AgentSettingsForm({ agent, initialPrompt, creationDefaults, onClose, onRemove, onSave, retainedForm, onFormChange, onDiscardForm, canResume,
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 }, workspaceId, workflowApprovalHandler, designatedOrchestrator = false, embedded = false,
}: {
  /** Inside an agent popover: the popover owns the title and close button. */
  embedded?: boolean
  retainedForm?: AgentForm
  onFormChange?(form: AgentForm): void
  onDiscardForm?(): void
  canResume?(): boolean
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
  designatedOrchestrator?: boolean
}) {
  const [localName, setLocalName] = useState(agent.name)
  const [localPrompt, setLocalPrompt] = useState(initialPrompt ?? '')
  const [error, setError] = useState<string>()
  const [issues, setIssues] = useState<FieldIssue[]>([])
  const [view, setView] = useState<'general' | 'advanced'>('general')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (issues.length) focusFirstInvalid(root.current) }, [issues])
  const [localEditor, setLocalEditor] = useState(() => {
    const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? 'codex'
    return createHarnessEditor(agent.harnessConfiguration ?? configuredHarness(agent, harness,
      initialModel(agent, harness), agent.effort ?? 'medium', agent.fastMode ?? false, 'read-only', creationDefaults))
  })
  const base = JSON.stringify({ agent, initialPrompt })
  const retained = retainedForm && sameWorkflowValue(JSON.parse(retainedForm.base), JSON.parse(base)) ? retainedForm : undefined
  const name = retained?.name ?? localName, prompt = retained?.prompt ?? localPrompt, editor = retained?.editor ?? localEditor
  const changeForm = (patch: Partial<AgentForm>) => onFormChange?.({ base, name, prompt, editor, ...patch })
  const setName = (value: string) => { if (onFormChange) changeForm({ name: value }); else setLocalName(value) }
  const setPrompt = (value: string) => { if (onFormChange) changeForm({ prompt: value }); else setLocalPrompt(value) }
  const setEditor = (update: typeof editor | ((current: typeof editor) => typeof editor)) => {
    const value = typeof update === 'function' ? update(editor) : update
    if (onFormChange) changeForm({ editor: value }); else setLocalEditor(value)
  }
  const initialSnapshot = useRef<string | undefined>(undefined)
  if (!initialSnapshot.current) initialSnapshot.current = JSON.stringify({ name: agent.name, prompt: initialPrompt ?? '', editor: localEditor })
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
    const previousSnapshot = initialSnapshot.current
    try {
      if (!name.trim()) throw new FieldValidationError([{ path: ['name'], message: 'Enter an agent name.' }])
      const nextConfiguration = (() => {
        try {
          const next = prepareHarnessEditor(editor)
          validateHarnessWorkflowCompatibility(next, workflowApprovalHandler, designatedOrchestrator)
          if (next.harness === 'codex' && workflowApprovalHandler) CodexSessionCompatibilitySchema.parse({ configuration: next, requiresResume: true })
          return next
        } catch (failure) {
          const harnessIssues = validationIssues(failure)
          if (harnessIssues.length) throw new FieldValidationError(harnessIssues.map((issue) => ({ ...issue,
            path: ['harness', ...(issue.path[0] === 'configuration' ? issue.path.slice(1) : issue.path)] })))
          throw failure
        }
      })()
      initialSnapshot.current = currentSnapshot
      onSave({ ...agent, name: name.trim(), harness: nextConfiguration.harness, model: nextConfiguration.model,
        effort: legacyEffortForHarness(nextConfiguration), fastMode: nextConfiguration.harness === 'codex' ? nextConfiguration.serviceTier === 'priority' : undefined,
        harnessConfiguration: nextConfiguration,
      }, prompt.trim() || undefined, executionPolicy)
    } catch (failure) {
      initialSnapshot.current = previousSnapshot
      const nextIssues = validationIssues(failure)
      setIssues(nextIssues)
      setError(nextIssues.length ? 'Review the marked fields before saving.' : failure instanceof Error ? failure.message : 'Agent settings are invalid.')
    }
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'agent settings', canResume, get dirty() { return currentSnapshot !== initialSnapshot.current },
    error, save, discard: () => { initialSnapshot.current = currentSnapshot; onDiscardForm?.(); onClose() },
  })
  return <div ref={root} className={`agent-settings-panel${embedded ? ' agent-settings-panel-embedded' : ''}`}>
    {embedded ? view === 'advanced' ? <header className="agent-settings-heading">
      <div className="agent-settings-title">
        <IconButton size="sm" variant="ghost" className="agent-settings-back" label="Back to general settings" onClick={() => setView('general')}><Icon name="chevron" size={15} /></IconButton>
        <strong>Advanced settings</strong>
      </div>
    </header> : null : <header className="agent-settings-heading">
      <div className="agent-settings-title">
        {view === 'advanced' ? <IconButton size="sm" variant="ghost" className="agent-settings-back" label="Back to general settings" onClick={() => setView('general')}><Icon name="chevron" size={15} /></IconButton> : null}
        <strong>{view === 'advanced' ? 'Advanced settings' : 'Agent settings'}</strong>
      </div>
      <div className="agent-settings-header-actions">
      <Button size="sm" variant="primary" className="agent-settings-save" aria-label="Save agent settings" disabled={!isDirty} onClick={save} leading={<Icon name="check" size={13} />}>Save</Button>
      <IconButton size="sm" variant="ghost" label="Close agent settings" onClick={() => void leave(onClose)}><Icon name="close" size={15} /></IconButton>
      </div>
    </header>}
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
        <HarnessBasicFields value={configuration} issues={issuesAt(issues, ['harness'])} onChange={updateConfiguration} />
      </div>
    </div> : <div className="agent-settings-advanced-view">
      <Textarea label="Initial prompt" aria-label="Initial prompt" className="agent-settings-prompt" rows={3} value={prompt} onChange={(event) => { setPrompt(event.target.value); clearErrors() }} />
      <HarnessConfigurationFields editor={editor} issues={issuesAt(issues, ['harness'])} onChange={(next) => { setEditor(next); clearErrors() }} allowHarnessChange={false} harnessDefaults={providerDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} allowAutoReview={workflowApprovalHandler === 'orchestrator'} compact advancedOnly />
      {embedded ? null : <p className="settings-help">Save updates this graph draft. Use Save graph to persist it.</p>}
    </div>}
    {error ? <Alert tone="danger" live title={error} /> : null}
    <footer className="agent-settings-footer">
      {view === 'general' ? <Button size="sm" variant="ghost" className="agent-settings-advanced-link" onClick={() => setView('advanced')} trailing={<Icon name="chevron" size={13} />}>Advanced settings</Button> : null}
      {onRemove ? embedded ? <Button size="sm" variant="ghost" className="agent-settings-trash" aria-label={`Remove ${agent.name} from workflow`} onClick={onRemove}>Remove from workflow</Button>
        : <IconButton size="sm" variant="ghost" className="agent-settings-trash" label={`Remove ${agent.name} from workflow`} onClick={onRemove}><Icon name="minus" size={15} /></IconButton> : null}
      {embedded ? <Button size="sm" variant="primary" className="agent-settings-save" aria-label="Save agent settings" disabled={!isDirty} onClick={save}>Apply</Button> : null}
    </footer>
  </div>
}
