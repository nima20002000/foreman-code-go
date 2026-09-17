import { Link } from '@tanstack/react-router'
import { WorkspaceDefaultsSchema, type WorkspaceDefaults } from '@graphql/contracts/management'
import { Button, ErrorState, LoadingState, TextField, Textarea } from '../../shared/ui/nocturne'
import { useWorkspaceDefaultsQuery, useUpdateWorkspaceDefaultsMutation } from '../../shared/api/settingsExperience'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { fieldMessage } from './fieldValidation'
import { useRevisionedForm } from './revisionedForm'
import { useSettingsValidation } from './useSettingsValidation'
import './settingsExperience.css'

export function WorkspaceDefaultsSettings() {
  const query = useWorkspaceDefaultsQuery()
  const mutation = useUpdateWorkspaceDefaultsMutation()
  const form = useRevisionedForm<WorkspaceDefaults>(query.data ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workspaces')
  const root = useSettingsValidation(form.issues)
  if (query.isError && !form.draft) return <ErrorState title="Workspace defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  const draft = form.draft
  if (!draft) return <LoadingState label="Loading workspace defaults…" />
  return <section ref={root} className="settings-editor-page" aria-label="Workspace defaults">
    <header className="settings-experience-heading"><h1>Workspaces</h1><p>Starting details for new workspaces. Existing workspaces do not change.</p></header>
    <SettingsFormFeedback form={form} />
    {query.isError ? <p role="alert">Could not refresh. Your edits are kept. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    <div className="settings-editor-content settings-single-column">
      <TextField label="Suggested workspace name" maxLength={200} value={draft.suggestedName} error={fieldMessage(form.issues ?? [], 'suggestedName')}
        onChange={(event) => form.setDraft({ ...draft, suggestedName: event.target.value })} />
      <Textarea label="Starting description" rows={4} maxLength={10_000} value={draft.description} error={fieldMessage(form.issues ?? [], 'description')}
        placeholder="Optional context for new workspaces" onChange={(event) => form.setDraft({ ...draft, description: event.target.value })} />
      <div className="settings-simple-row"><strong>Execution folders & runners</strong><p>Choose these for each workspace. Defaults never grant file access.</p>
        <Link to="/workspaces" className="settings-text-link">Open existing workspaces →</Link></div>
    </div>
    <SettingsFormActions form={form} saveLabel="Save workspace defaults" onSave={() => void form.save(async (input) => {
      const response = await mutation.mutateAsync({ ...input, value: WorkspaceDefaultsSchema.parse(input.value) })
      return { value: response.value.value, revision: response.value.revision }
    }, (value) => WorkspaceDefaultsSchema.parse(value))} />
  </section>
}
