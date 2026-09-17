import { Alert, Button } from '../../shared/ui/nocturne'
import type { SettingsChange } from './revisionedFormChanges'
import './settingsUsability.css'

interface SettingsFormState {
  isDirty: boolean
  isSaving: boolean
  uncertain: boolean
  conflicted: boolean
  error?: string
  savedRevision?: number
  serverChanges: SettingsChange[]
  localChanges: SettingsChange[]
  reset(): void
  reapply(): void
}

function ChangeList({ title, changes }: { title: string; changes: SettingsChange[] }) {
  return <details><summary>{title} ({changes.length})</summary>
    {changes.map((change) => <div key={change.path}><strong>{change.path}</strong>
      <p>Before</p><pre>{JSON.stringify(change.before, null, 2) ?? '(not set)'}</pre>
      <p>After</p><pre>{JSON.stringify(change.after, null, 2) ?? '(not set)'}</pre>
    </div>)}
  </details>
}

export function SettingsFormFeedback({ form }: { form: SettingsFormState }) {
  return <>
    {form.conflicted ? <div className="settings-form-feedback settings-defaults-conflict" role="alert">
      <Alert tone="warning" title="These defaults changed elsewhere. Your edits are preserved.">
        <ChangeList title="Changes to current defaults" changes={form.serverChanges} />
        <ChangeList title="Your edits" changes={form.localChanges} />
        <p>Reapplying keeps your changed fields, including whole permission-rule lists, and loads current defaults for untouched fields. Your choices win where both changed. Review them before saving.</p>
        <div className="settings-defaults-conflict-actions">
          <Button disabled={form.isSaving || form.uncertain} onClick={form.reapply}>Reapply my edits to current defaults</Button>
          <Button disabled={form.isSaving || form.uncertain} onClick={form.reset}>Discard edits and load current defaults</Button>
        </div>
      </Alert>
    </div> : null}
    {form.uncertain ? <div className="settings-form-feedback"><Alert live tone="warning" title="The previous save may have committed. Retry resolves that exact command; edits made afterward remain unsaved. Discard and reapply are unavailable until its outcome is known." /></div> : null}
    {form.error ? <div className="settings-form-feedback"><Alert live tone="danger" title={form.error} /></div> : null}
  </>
}

export function SettingsFormActions({ form, onSave }: { form: SettingsFormState; onSave(): void }) {
  return <footer className="settings-save-actions">
    <p role="status" aria-live="polite">{form.isSaving ? 'Saving…' : form.savedRevision !== undefined
      ? form.isDirty ? 'Saved submitted changes. Newer edits remain unsaved.' : 'Saved.'
      : form.isDirty ? 'Unsaved changes.' : 'No unsaved changes.'}</p>
    {!form.conflicted ? <Button disabled={!form.isDirty || form.isSaving || form.uncertain} onClick={form.reset}>Discard changes</Button> : null}
    <Button variant="primary" disabled={form.isSaving || (!form.isDirty && !form.uncertain) || (form.conflicted && !form.uncertain)} onClick={onSave}>
      {form.isSaving ? 'Saving…' : form.uncertain ? 'Retry original save' : 'Save defaults'}
    </Button>
  </footer>
}
