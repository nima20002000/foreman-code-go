import type { WorkflowDefaults } from '@graphql/contracts'

import { useUpdateWorkflowDefaultsMutation, useWorkflowDefaultsQuery } from '../../shared/api/query'
import { useRevisionedForm } from './revisionedForm'

export function WorkflowDefaultsSettings() {
  const query = useWorkflowDefaultsQuery()
  const mutation = useUpdateWorkflowDefaultsMutation()
  const { draft, baseRevision, isDirty, conflicted, setDraft, acknowledge, reset } = useRevisionedForm<WorkflowDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined)
  if (query.isPending || !draft) return <p className="settings-state" role="status">Loading workflow defaults…</p>
  if (query.isError) return <p className="settings-state" role="alert">Workflow defaults are unavailable.</p>
  return <section className="settings-form settings-form-compact" aria-labelledby="workflow-defaults-title">
    <header className="settings-form-heading"><div><p className="panel-kicker">New workflows</p><h2 id="workflow-defaults-title">Workflow defaults</h2><p>New workflows copy this handler. Existing and in-flight approvals do not change.</p></div>
      <button type="button" disabled={!isDirty || mutation.isPending} onClick={async () => {
        const submitted = draft
        const response = await mutation.mutateAsync({ value: submitted, expectedRevision: baseRevision!, commandId: crypto.randomUUID() })
        acknowledge(submitted, response.value.value, response.value.revision)
      }}>{mutation.isPending ? 'Saving…' : 'Save defaults'}</button></header>
    {conflicted ? <div className="settings-conflict" role="alert">These defaults changed elsewhere. Your edit was preserved.<button type="button" onClick={reset}>Load current defaults</button></div> : null}
    <label className="settings-prominent-field">Approval handler<select value={draft.approvalHandler} onChange={(event) => setDraft({ approvalHandler: event.target.value as WorkflowDefaults['approvalHandler'] })}>
      <option value="orchestrator">Orchestrator</option><option value="user">User</option><option value="operator">Operator</option>
    </select><small>Normal graph edges do not determine approval authority; workflow roles and settings do.</small></label>
    {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
  </section>
}
