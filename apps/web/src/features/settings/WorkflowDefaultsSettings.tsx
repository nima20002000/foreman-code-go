import { useId } from 'react'
import { WorkflowDefaultsSchema, type WorkflowDefaults } from '@graphql/contracts'

import { useUpdateWorkflowDefaultsMutation, useWorkflowDefaultsQuery } from '../../shared/api/query'
import { fieldMessage } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm } from './revisionedForm'

export function WorkflowDefaultsSettings() {
  const query = useWorkflowDefaultsQuery()
  const mutation = useUpdateWorkflowDefaultsMutation()
  const form = useRevisionedForm<WorkflowDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workflows')
  const root = useSettingsValidation(form.issues)
  const errorId = useId()
  const handlerError = fieldMessage(form.issues ?? [], 'approvalHandler')
  const draft = form.draft
  if (query.isError && !draft) return <div className="settings-form settings-state-error" role="alert"><p>Workflow defaults are unavailable. {query.error.message}</p><button type="button" className="settings-primary-button" onClick={() => void query.refetch()}>Retry</button></div>
  if (!draft) return <div className="settings-form"><p role="status">Loading workflow defaults…</p></div>
  return <section ref={root} className="settings-form settings-form-compact" aria-label="Workflow defaults">
    {query.isError ? <p role="alert">The refresh failed. Your draft is preserved.<button type="button" onClick={() => void query.refetch()}>Retry refresh</button></p> : null}
    <SettingsFormFeedback form={form} />
    <label className="settings-prominent-field">Approval handler<select aria-invalid={handlerError ? true : undefined} aria-describedby={handlerError ? errorId : undefined} value={draft.approvalHandler} onChange={(event) => form.setDraft({ approvalHandler: event.target.value as WorkflowDefaults['approvalHandler'] })}>
      <option value="orchestrator">Orchestrator</option><option value="user">User</option><option value="operator">Operator</option>
    </select><small>Normal graph edges do not determine approval authority; workflow roles and settings do.</small>{handlerError ? <small id={errorId} className="settings-field-error">{handlerError}</small> : null}</label>
    <SettingsFormActions form={form} onSave={() => void form.save(async (input) => {
      const response = await mutation.mutateAsync(input)
      return { value: response.value.value, revision: response.value.revision }
    }, (value) => WorkflowDefaultsSchema.parse(value))} />
  </section>
}
