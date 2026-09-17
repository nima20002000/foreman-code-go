import { WorkflowDefaultsSchema, type WorkflowDefaults } from '@graphql/contracts'

import { useUpdateWorkflowDefaultsMutation, useWorkflowDefaultsQuery } from '../../shared/api/query'
import { Alert, Button, LoadingState, Select, SettingsSection } from '../../shared/ui/nocturne'
import { fieldMessage } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm } from './revisionedForm'

const approvalOptions = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'user', label: 'User' },
  { value: 'operator', label: 'Operator' },
] as const

export function WorkflowDefaultsSettings() {
  const query = useWorkflowDefaultsQuery()
  const mutation = useUpdateWorkflowDefaultsMutation()
  const form = useRevisionedForm<WorkflowDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workflows')
  const root = useSettingsValidation(form.issues)
  const handlerError = fieldMessage(form.issues ?? [], 'approvalHandler')
  const draft = form.draft
  if (query.isError && !draft) return <Alert live tone="danger" title={`Workflow defaults are unavailable. ${query.error.message}`} action={<Button onClick={() => void query.refetch()}>Retry</Button>} />
  if (!draft) return <LoadingState label="Loading workflow defaults…" />
  return <SettingsSection title="Workflow defaults">
    <div ref={(node) => { root.current = node }}>
      {query.isError ? <div className="settings-form-feedback"><Alert live tone="danger" title="The refresh failed. Your draft is preserved." action={<Button onClick={() => void query.refetch()}>Retry refresh</Button>} /></div> : null}
      <SettingsFormFeedback form={form} />
      <Select label="Approval handler" value={draft.approvalHandler} error={handlerError} hint="Normal graph edges do not determine approval authority; workflow roles and settings do." options={approvalOptions}
        onChange={(event) => form.setDraft({ approvalHandler: event.target.value as WorkflowDefaults['approvalHandler'] })} />
    </div>
    <SettingsFormActions form={form} onSave={() => void form.save(async (input) => {
      const response = await mutation.mutateAsync(input)
      return { value: response.value.value, revision: response.value.revision }
    }, (value) => WorkflowDefaultsSchema.parse(value))} />
  </SettingsSection>
}
