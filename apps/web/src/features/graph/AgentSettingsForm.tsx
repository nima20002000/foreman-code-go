import { useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import {
  CodexSessionCompatibilitySchema, legacyEffortForHarness, validateHarnessWorkflowCompatibility,
  type Agent, type ApprovalHandler, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@graphql/contracts'

import { configuredHarness, initialModel } from '../agents/agentSettings'
import { HarnessConfigurationFields } from '../settings/HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor } from '../settings/harnessEditor'

export function AgentSettingsForm({ agent, initialPrompt, creationDefaults, onClose, onRemove, onSave,
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 }, workflowNodeCount = 1,
  workspaceId, workflowApprovalHandler,
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
  const [maxNodeExecutions, setMaxNodeExecutions] = useState(executionPolicy.maxNodeExecutions)
  const [maxParallelism, setMaxParallelism] = useState(executionPolicy.maxParallelism)
  const [error, setError] = useState<string>()
  const [editor, setEditor] = useState(() => {
    const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? 'codex'
    return createHarnessEditor(agent.harnessConfiguration ?? configuredHarness(agent, harness,
      initialModel(agent, harness), agent.effort ?? 'medium', agent.fastMode ?? false, 'read-only', creationDefaults))
  })
  const validLimits = Number.isInteger(maxNodeExecutions) && maxNodeExecutions >= workflowNodeCount && maxNodeExecutions <= 10_000
    && Number.isInteger(maxParallelism) && maxParallelism >= 1 && maxParallelism <= 100
  const invalidNodeLimit = !Number.isInteger(maxNodeExecutions) || maxNodeExecutions < workflowNodeCount || maxNodeExecutions > 10_000
  const invalidParallelism = !Number.isInteger(maxParallelism) || maxParallelism < 1 || maxParallelism > 100
  return <>
    <header className="agent-settings-heading"><strong>Agent settings</strong><div>
      {onRemove ? <button type="button" aria-label={`Remove ${agent.name} from workflow`} onClick={onRemove}><Trash2 size={16} /></button> : null}
      <button type="button" aria-label="Close agent settings" onClick={onClose}><X size={15} /></button>
    </div></header>
    <label>Name<input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <HarnessConfigurationFields editor={editor} onChange={setEditor} harnessDefaults={creationDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} />
    <label>Initial prompt<textarea aria-label="Initial prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
    <fieldset className="agent-settings-limits"><legend>Workflow limits</legend>
      <label>Maximum node executions<input type="number" min={workflowNodeCount} max={10_000} step={1} aria-invalid={invalidNodeLimit} value={Number.isNaN(maxNodeExecutions) ? '' : maxNodeExecutions} onChange={(event) => setMaxNodeExecutions(event.target.valueAsNumber)} /></label>
      <label>Maximum parallel agents<input type="number" min={1} max={100} step={1} aria-invalid={invalidParallelism} value={Number.isNaN(maxParallelism) ? '' : maxParallelism} onChange={(event) => setMaxParallelism(event.target.valueAsNumber)} /></label>
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    <div className="agent-settings-actions"><button type="button" className="agent-settings-save" aria-label="Save agent settings" disabled={!name.trim() || !validLimits} onClick={() => {
      try {
        const configuration = prepareHarnessEditor(editor)
        validateHarnessWorkflowCompatibility(configuration, workflowApprovalHandler)
        if (configuration.harness === 'opencode' && configuration.autoApprove) throw new Error('Native auto approval is not supported by the managed OpenCode server. Select GraphQL routed review.')
        if (configuration.harness === 'codex' && workflowApprovalHandler) CodexSessionCompatibilitySchema.parse({ configuration, requiresResume: true })
        onSave({ ...agent, name: name.trim(), harness: configuration.harness, model: configuration.model,
          effort: legacyEffortForHarness(configuration), fastMode: configuration.harness === 'codex' ? configuration.serviceTier === 'priority' : undefined,
          harnessConfiguration: configuration,
        }, prompt.trim() || undefined, { maxNodeExecutions, maxParallelism })
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Agent settings are invalid.') }
    }}><Check size={16} /></button></div>
  </>
}
