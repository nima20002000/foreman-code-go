import { type HarnessDefaults, HarnessDefaultsSchema } from '@graphql/contracts'
import { ManagementHarnessDefaultsSchema } from '@graphql/contracts/management'

import {
  useHarnessDefaultsQuery, useManagedHarnessCatalogQuery,
  useSaveHarnessDefaultsMutation, useUpdateManagedHarnessDefaultsMutation,
} from '../../shared/api/query'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { issuesAt, withValidationPath } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm } from './revisionedForm'

type DefaultsEditor = { codex: HarnessEditor; opencode: HarnessEditor }
function editable(value: HarnessDefaults): DefaultsEditor {
  return { codex: createHarnessEditor(value.codex), opencode: createHarnessEditor(value.opencode) }
}
function prepared(value: DefaultsEditor): HarnessDefaults {
  return HarnessDefaultsSchema.parse({
    codex: withValidationPath(['codex'], () => prepareHarnessEditor(value.codex)),
    opencode: withValidationPath(['opencode'], () => prepareHarnessEditor(value.opencode)),
  })
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
  const root = useSettingsValidation(form.issues)
  const draft = form.draft
  const query = realMode ? catalogQuery : defaultsQuery
  if (query.isError && !draft) return <div className="settings-form settings-state-error" role="alert"><p>Harness defaults are unavailable.</p><button type="button" className="settings-primary-button" onClick={() => void query.refetch()}>Retry</button></div>
  if (!draft) return <div className="settings-form"><p role="status">Loading harness defaults…</p></div>
  return <section ref={root} className="settings-form" aria-label="Harness defaults">
    {query.isError ? <p role="alert">The refresh failed. Your draft is preserved.<button type="button" onClick={() => void query.refetch()}>Retry refresh</button></p> : null}
    <SettingsFormFeedback form={form} />
    <div className="harness-defaults-grid">{(['codex', 'opencode'] as const).map((harness) => <fieldset key={harness}><legend>{harness === 'codex' ? 'Codex' : 'OpenCode'}</legend><div className="settings-field-grid"><HarnessConfigurationFields allowHarnessChange={false} editor={draft[harness]} issues={issuesAt(form.issues ?? [], [harness])} onChange={(value) => form.setDraft((current) => current && ({ ...current, [harness]: value }))} /></div></fieldset>)}</div>
    <SettingsFormActions form={form} onSave={() => void form.save(async (input) => {
      const defaults = prepared(input.value)
      if (realMode) {
        const response = await managedSaveMutation.mutateAsync({ defaults: ManagementHarnessDefaultsSchema.parse(defaults), expectedRevision: input.expectedRevision, commandId: input.commandId })
        return { value: editable(response.value.defaults), revision: response.value.revision }
      }
      const response = await saveMutation.mutateAsync({ defaults })
      return { value: editable(response.defaults), revision: 0 }
    }, (value) => { const defaults = prepared(value); if (realMode) ManagementHarnessDefaultsSchema.parse(defaults); return value })} />
  </section>
}
