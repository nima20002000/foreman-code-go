import { WorkflowDefaultsSchema, type WorkflowDefaults } from '@graphql/contracts'

import { useUpdateWorkflowDefaultsMutation, useWorkflowDefaultsQuery } from '../../shared/api/query'
import { useRevisionedForm } from './revisionedForm'

export function WorkflowDefaultsSettings() {
  const query = useWorkflowDefaultsQuery()
  const mutation = useUpdateWorkflowDefaultsMutation()
  const form = useRevisionedForm<WorkflowDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workflows')
  const draft = form.draft
  if (query.isError && !draft) return <div role="alert"><p>Workflow defaults are unavailable. {query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Retry</button></div>
  if (!draft) return <p role="status">Loading workflow defaults…</p>
  return <section className="settings-form settings-form-compact" aria-labelledby="workflow-defaults-title">
    <header className="settings-form-heading"><div><p className="panel-kicker">New workflows</p><h2 id="workflow-defaults-title">Workflow defaults</h2><p>New workflows copy this handler. Existing and in-flight approvals do not change.</p></div>
      <button type="button" disabled={form.isSaving || (!form.isDirty && !form.uncertain) || (form.conflicted && !form.uncertain)} onClick={() => void form.save(async (input) => {
        const response = await mutation.mutateAsync(input)
        return { value: response.value.value, revision: response.value.revision }
      }, (value) => WorkflowDefaultsSchema.parse(value))}>{form.isSaving ? 'Saving…' : form.uncertain ? 'Retry original save' : 'Save defaults'}</button></header>
    {query.isError ? <p role="alert">The refresh failed. Your draft is preserved.<button type="button" onClick={() => void query.refetch()}>Retry refresh</button></p> : null}
    {form.conflicted ? <div role="alert">These defaults changed elsewhere. Your edit was preserved.<button type="button" disabled={form.isSaving || form.uncertain} onClick={form.reset}>Load current defaults</button></div> : null}
    {form.uncertain ? <p role="status">The previous save may have committed. Retry resolves that same request, without submitting newer edits.</p> : null}
    <label className="settings-prominent-field">Approval handler<select value={draft.approvalHandler} onChange={(event) => form.setDraft({ approvalHandler: event.target.value as WorkflowDefaults['approvalHandler'] })}>
      <option value="orchestrator">Orchestrator</option><option value="user">User</option><option value="operator">Operator</option>
    </select><small>Normal graph edges do not determine approval authority; workflow roles and settings do.</small></label>
    {form.error ? <p role="alert">{form.error}</p> : null}
    {form.isDirty ? <p role="status">Unsaved changes.</p> : null}
  </section>
}
