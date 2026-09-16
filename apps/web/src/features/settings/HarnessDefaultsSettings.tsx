import { type HarnessDefaults, HarnessDefaultsSchema } from '@graphql/contracts'
import { ManagementHarnessDefaultsSchema } from '@graphql/contracts/management'

import {
  useHarnessDefaultsQuery, useManagedHarnessCatalogQuery,
  useSaveHarnessDefaultsMutation, useUpdateManagedHarnessDefaultsMutation,
} from '../../shared/api/query'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { useRevisionedForm } from './revisionedForm'

type DefaultsEditor = { codex: HarnessEditor; opencode: HarnessEditor }
function editable(value: HarnessDefaults): DefaultsEditor {
  return { codex: createHarnessEditor(value.codex), opencode: createHarnessEditor(value.opencode) }
}
function prepared(value: DefaultsEditor): HarnessDefaults {
  return HarnessDefaultsSchema.parse({ codex: prepareHarnessEditor(value.codex), opencode: prepareHarnessEditor(value.opencode) })
}

export function HarnessDefaultsSettings() {
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false')
  const defaultsQuery = useHarnessDefaultsQuery({ enabled: !realMode })
  const catalogQuery = useManagedHarnessCatalogQuery(realMode)
  const saveMutation = useSaveHarnessDefaultsMutation()
  const managedSaveMutation = useUpdateManagedHarnessDefaultsMutation()
  const codex = catalogQuery.data?.find((entry) => entry.harness === 'codex')
  const opencode = catalogQuery.data?.find((entry) => entry.harness === 'opencode')
  const incoming = realMode
    ? codex?.defaults.harness === 'codex' && opencode?.defaults.harness === 'opencode' && codex.defaultsRevision === opencode.defaultsRevision
      ? { value: editable({ codex: codex.defaults, opencode: opencode.defaults }), revision: codex.defaultsRevision } : undefined
    : defaultsQuery.data ? { value: editable(defaultsQuery.data.defaults), revision: 0 } : undefined
  const form = useRevisionedForm<DefaultsEditor>(incoming, 'settings:harnesses')
  const draft = form.draft
  const query = realMode ? catalogQuery : defaultsQuery
  if (query.isError && !draft) return <div role="alert"><p>Harness defaults are unavailable.</p><button type="button" onClick={() => void query.refetch()}>Retry</button></div>
  if (!draft) return <p role="status">Loading harness defaults…</p>
  return <section className="harness-defaults" aria-labelledby="harness-defaults-title">
    <header className="harness-defaults-heading"><div><h2 id="harness-defaults-title">Harness defaults</h2><p>Provider presets. Role templates under Agents determine new board Agent defaults; existing Agents never change.</p></div>
      <button type="button" disabled={form.isSaving || (!form.isDirty && !form.uncertain) || (form.conflicted && !form.uncertain)} onClick={() => void form.save(async (input) => {
        const defaults = prepared(input.value)
        if (realMode) {
          const response = await managedSaveMutation.mutateAsync({ defaults: ManagementHarnessDefaultsSchema.parse(defaults), expectedRevision: input.expectedRevision, commandId: input.commandId })
          return { value: editable(response.value.defaults), revision: response.value.revision }
        }
        const response = await saveMutation.mutateAsync({ defaults })
        return { value: editable(response.defaults), revision: 0 }
      }, (value) => { const defaults = prepared(value); if (realMode) ManagementHarnessDefaultsSchema.parse(defaults); return value })}>{form.isSaving ? 'Saving…' : form.uncertain ? 'Retry original save' : 'Save defaults'}</button>
    </header>
    {query.isError ? <p role="alert">The refresh failed. Your draft is preserved.<button type="button" onClick={() => void query.refetch()}>Retry refresh</button></p> : null}
    {form.conflicted ? <div role="alert">These defaults changed elsewhere. Your edits keep their original revision.<button type="button" disabled={form.isSaving || form.uncertain} onClick={form.reset}>Discard edits and load current defaults</button></div> : null}
    {form.uncertain ? <p role="status">The previous save may have committed. Retry resolves that same request. Newer edits remain unsaved.</p> : null}
    <div className="harness-defaults-grid">{(['codex', 'opencode'] as const).map((harness) => <fieldset key={harness}><legend>{harness === 'codex' ? 'Codex' : 'OpenCode'}</legend><HarnessConfigurationFields allowHarnessChange={false} editor={draft[harness]} onChange={(value) => form.setDraft((current) => current && ({ ...current, [harness]: value }))} /></fieldset>)}</div>
    {form.isDirty ? <p role="status">Unsaved changes.</p> : null}
    {form.error ? <p role="alert">{form.error}</p> : null}
  </section>
}
