import { useState } from 'react'
import { type HarnessDefaults, HarnessDefaultsSchema } from '@graphql/contracts'
import { ManagementHarnessDefaultsSchema, type HarnessSettingsSection } from '@graphql/contracts/management'
import { Button, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { useManagedHarnessCatalogQuery, useUpdateManagedHarnessDefaultsMutation } from '../../shared/api/query'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { HarnessCompatibilityPanel } from './HarnessCompatibilityPanel'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { issuesAt, withValidationPath } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm, useSettingsDraftStatus } from './revisionedForm'
import { SettingsChoice, SettingsEditorLayout, SettingsOverview } from './SettingsEditorLayout'
import { harnessSummary } from './settingsPresentation'

type Harness = 'codex' | 'opencode'
type DefaultsEditor = { codex: HarnessEditor; opencode: HarnessEditor }
function editable(value: HarnessDefaults): DefaultsEditor { return { codex: createHarnessEditor(value.codex), opencode: createHarnessEditor(value.opencode) } }
function prepared(value: DefaultsEditor): HarnessDefaults {
  return HarnessDefaultsSchema.parse({
    codex: withValidationPath(['codex'], () => prepareHarnessEditor(value.codex)),
    opencode: withValidationPath(['opencode'], () => prepareHarnessEditor(value.opencode)),
  })
}
function useProviderDefaults() {
  const catalogQuery = useManagedHarnessCatalogQuery(true)
  const codex = catalogQuery.data?.find((entry) => entry.harness === 'codex')
  const opencode = catalogQuery.data?.find((entry) => entry.harness === 'opencode')
  const incoming = codex?.defaults.harness === 'codex' && opencode?.defaults.harness === 'opencode' && codex.defaultsRevision === opencode.defaultsRevision
    ? { value: { codex: codex.defaults, opencode: opencode.defaults }, revision: codex.defaultsRevision }
    : undefined
  return { incoming, query: catalogQuery }
}
function ProviderCard({ harness, value, onSelect }: { harness: Harness; value: HarnessDefaults; onSelect(): void }) {
  const status = useSettingsDraftStatus(`settings:harnesses:${harness}`)
  return <SettingsChoice icon="settings" title={harness === 'codex' ? 'Codex' : 'OpenCode'}
    description={harness === 'codex' ? 'Native app-server' : 'Native server'} summary={harnessSummary(value[harness]).filter((item) => item.label !== 'Harness')}
    draftStatus={status} onSelect={onSelect} />
}
export function HarnessDefaultsSettings({ selectedHarness, section: selectedSection, onSelectHarness, onSectionChange }: {
  selectedHarness?: Harness; section?: HarnessSettingsSection;
  onSelectHarness?(harness: Harness | undefined): void; onSectionChange?(section: HarnessSettingsSection): void;
}) {
  const { incoming, query } = useProviderDefaults()
  const [localHarness, setLocalHarness] = useState<Harness>()
  const [localSection, setLocalSection] = useState<HarnessSettingsSection>('model')
  const harness = onSelectHarness ? selectedHarness : localHarness
  const section = selectedSection ?? localSection
  const choose = (next: Harness | undefined) => { setLocalHarness(next); setLocalSection('model'); onSelectHarness?.(next) }
  const navigateSection = (next: HarnessSettingsSection) => { setLocalSection(next); onSectionChange?.(next) }
  if (harness) return <ProviderEditor showBack={!onSelectHarness} key={harness} harness={harness} section={section} onSectionChange={navigateSection} onBack={() => choose(undefined)} />
  if (query.isError || (query.isSuccess && !incoming)) return <ErrorState title="Harness defaults are unavailable"
    description={query.error?.message ?? 'The server returned an incomplete provider catalog.'} onRetry={() => void query.refetch()} />
  if (!incoming) return <LoadingState label="Loading harness defaults…" />
  return <SettingsOverview title="Harnesses" description="Choose a provider to edit its preset or manage its connections.">
    {(['codex', 'opencode'] as const).map((item) => <ProviderCard key={item} harness={item} value={incoming.value} onSelect={() => choose(item)} />)}
  </SettingsOverview>
}
function ProviderEditor({ harness, section, onSectionChange, onBack, showBack }: {
  harness: Harness; section: HarnessSettingsSection; onSectionChange(section: HarnessSettingsSection): void; onBack(): void; showBack: boolean;
}) {
  const { incoming, query } = useProviderDefaults()
  const form = useRevisionedForm<DefaultsEditor>(incoming ? { value: editable(incoming.value), revision: incoming.revision } : undefined, `settings:harnesses:${harness}`)
  const managedSave = useUpdateManagedHarnessDefaultsMutation()
  const root = useSettingsValidation(form.issues)
  const draft = form.draft
  const name = harness === 'codex' ? 'Codex' : 'OpenCode'
  if (!draft && (query.isError || (query.isSuccess && !incoming))) return <ErrorState title="Harness defaults are unavailable" description={query.error?.message ?? 'The server returned an incomplete provider catalog.'} onRetry={() => void query.refetch()} />
  if (!draft) return <LoadingState label="Loading provider defaults…" />
  const update = (next: HarnessEditor) => form.setDraft((current) => current && ({ ...current, [harness]: next }))
  return <div ref={(node) => { root.current = node }}><SettingsEditorLayout showBack={showBack} title={`${name} settings`} description="Provider preset for new configurations. Existing agents and sessions keep their settings."
    backLabel="All harnesses" onBack={onBack} section={section} onSectionChange={onSectionChange} connections
    feedback={<>{query.isError ? <p role="alert">Could not refresh. Your draft is kept. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}<SettingsFormFeedback form={form} /></>}
    footer={section === 'connections' || section === 'workspace' ? null : <SettingsFormActions form={form} saveLabel={`Save ${name} preset`}
      onSave={() => form.save(async (input) => {
        const defaults = prepared(input.value)
        const response = await managedSave.mutateAsync({ defaults: ManagementHarnessDefaultsSchema.parse(defaults), expectedRevision: input.expectedRevision, commandId: input.commandId })
        return { value: editable(response.value.defaults), revision: response.value.revision }
      }, (value) => { ManagementHarnessDefaultsSchema.parse(prepared(value)); return value })} />}>
    {section === 'workspace' ? <HarnessCompatibilityPanel harness={harness} /> : null}
    <HarnessConfigurationFields allowHarnessChange={false} editor={draft[harness]} onChange={update} issues={issuesAt(form.issues ?? [], [harness])}
      section={section} onSectionChange={onSectionChange} frameless />
  </SettingsEditorLayout></div>
}
