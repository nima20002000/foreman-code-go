import { useEffect, useId, useRef, useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import {
  CodexSessionCompatibilitySchema, legacyEffortForHarness, validateHarnessWorkflowCompatibility,
  type Agent, type ApprovalHandler, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@graphql/contracts'

import { configuredHarness, initialModel } from '../agents/agentSettings'
import { HarnessConfigurationFields } from '../settings/HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor } from '../settings/harnessEditor'
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
  const root = useRef<HTMLDivElement>(null)
  const nameErrorId = useId()
  useEffect(() => { if (issues.length) focusFirstInvalid(root.current) }, [issues])
  const [editor, setEditor] = useState(() => {
    const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? 'codex'
    return createHarnessEditor(agent.harnessConfiguration ?? configuredHarness(agent, harness,
      initialModel(agent, harness), agent.effort ?? 'medium', agent.fastMode ?? false, 'read-only', creationDefaults))
  })
  const nameError = fieldMessage(issues, 'name')
  const clearErrors = () => { setError(undefined); setIssues([]) }
  return <div ref={root} className="agent-settings-panel">
    <header className="agent-settings-heading"><strong>Agent settings</strong><div>
      {onRemove ? <button type="button" aria-label={`Remove ${agent.name} from workflow`} onClick={onRemove}><Trash2 size={16} /></button> : null}
      <button type="button" aria-label="Close agent settings" onClick={onClose}><X size={15} /></button>
    </div></header>
    <div className="agent-settings-fields">
      <label className="agent-settings-full-width">Name<input aria-label="Name" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? nameErrorId : undefined} value={name} onChange={(event) => { setName(event.target.value); clearErrors() }} />{nameError ? <small id={nameErrorId} className="settings-field-error">{nameError}</small> : null}</label>
      <HarnessConfigurationFields editor={editor} issues={issuesAt(issues, ['harness'])} onChange={(next) => { setEditor(next); clearErrors() }} harnessDefaults={creationDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} compact />
      <label className="agent-settings-full-width">Initial prompt<textarea aria-label="Initial prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <p className="settings-help">Workflow-wide execution limits are in Workflow settings. Applying these agent settings updates the draft only; use Save graph to persist them.</p>
    </div>
    <footer className="agent-settings-actions">
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" className="agent-settings-save" aria-label="Apply to draft" onClick={() => {
      try {
        if (!name.trim()) throw new FieldValidationError([{ path: ['name'], message: 'Enter an agent name.' }])
        const configuration = (() => {
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
        onSave({ ...agent, name: name.trim(), harness: configuration.harness, model: configuration.model,
          effort: legacyEffortForHarness(configuration), fastMode: configuration.harness === 'codex' ? configuration.serviceTier === 'priority' : undefined,
          harnessConfiguration: configuration,
        }, prompt.trim() || undefined, executionPolicy)
      } catch (failure) {
        const nextIssues = validationIssues(failure)
        setIssues(nextIssues)
        setError(nextIssues.length ? 'Review the marked fields before applying to the draft.' : failure instanceof Error ? failure.message : 'Agent settings are invalid.')
      }
      }}><Check size={16} /> Apply to draft</button>
    </footer>
  </div>
}
