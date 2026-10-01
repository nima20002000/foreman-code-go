import { useEffect } from 'react'
import { create } from 'zustand'
import type { HostHarnessOverride, HostHarnessOverrideListInput, HostHarnessOverrideTargetSchema } from '@graphql/contracts/harness-registry'
import type { z } from 'zod'
import { useHostHarnessOverridesQuery, useHostHarnessRegistryQuery, useSaveHostHarnessOverride } from '../../shared/api/computerSettings'
import { sessionGeneration, sessionSignal } from '../../shared/api/sessionBoundary'
import { Alert, Checkbox, Select, Button, LoadingState } from '../../shared/ui/nocturne'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useRevisionedForm } from './revisionedForm'
import { createHarnessEditor, prepareHarnessEditor, type HarnessEditor } from './harnessEditor'
import { HostHarnessProfileCheck } from './HostHarnessProfileCheck'
import { HostHarnessConfigurationFields } from './HostHarnessConfigurationFields'

type EditorValue = { enabled: boolean; editor: HarnessEditor }
type Seed = { instanceId: string; target: z.infer<typeof HostHarnessOverrideTargetSchema>; presetId: string; value: EditorValue }
const useCreation = create<{ seeds: Record<string, Seed | undefined>; selections: Record<string, string | undefined>; select(key: string, selection: string): void; put(key: string, seed?: Seed): void }>(set => ({
  seeds: {}, selections: {}, select: (key, selection) => set(state => ({ selections: { ...state.selections, [key]: selection } })),
  put: (key, seed) => set(state => ({ seeds: { ...state.seeds, [key]: seed } })),
}))
function editable(value: HostHarnessOverride): EditorValue { return { enabled: value.enabled, editor: createHarnessEditor(value.configuration) } }
function OverrideEditor({ value, seed, onCreated, onCancelled }: { value?: HostHarnessOverride; seed?: Seed; onCreated?(): void; onCancelled?(): void }) {
  const instanceId = value?.instanceId ?? seed!.instanceId
  const target = value?.target ?? seed!.target
  const presetId = value?.presetId ?? seed!.presetId
  const incoming = value ? editable(value) : seed!.value
  const form = useRevisionedForm({ value: incoming, revision: value?.revision ?? 0 }, `settings:host-harness:${JSON.stringify(target)}:${instanceId}`)
  const save = useSaveHostHarnessOverride()
  const draft = form.draft
  if (!draft) return <LoadingState label="Loading instance settings…" />
  const submit = () => form.save(async input => {
    const result = await save.mutateAsync({ commandId: input.commandId, expectedRevision: input.expectedRevision,
      instanceId, target, presetId, enabled: input.value.enabled, configuration: prepareHarnessEditor(input.value.editor) })
    onCreated?.()
    return { value: editable(result.value), revision: result.value.revision }
  }, input => { prepareHarnessEditor(input.editor); return input })
  return <section className="computer-inventory-item" aria-label={`${draft.editor.configuration.harness} host settings`}>
    <h3>{draft.editor.configuration.harness} · {value ? 'host override' : 'new host override'}</h3>
    <dl className="computer-facts computer-facts--status">
      <div><dt>Saved immutable revision</dt><dd>{value?.instanceRevision ?? 'Not created'}</dd></div>
      <div><dt>Qualification</dt><dd>{value?.qualification ?? 'Unqualified'}</dd></div>
    </dl>
    <details className="computer-details"><summary>Source and installation</summary>
      <dl className="computer-facts">
        <div><dt>Instance</dt><dd>{instanceId}</dd></div>
        <div><dt>Preset source</dt><dd>{presetId}</dd></div>
        <div><dt>Harness installation</dt><dd>{target.harnessInstallationId} · {target.installationFingerprint}</dd></div>
      </dl>
    </details>
    <p className="computer-hint">Changes apply to new admissions on this computer. Accepted Runs and sessions keep their pinned settings.</p>
    <Checkbox label="Enabled for new admissions" checked={draft.enabled} onChange={event => form.setDraft(current => current && ({ ...current, enabled: event.target.checked }))} />
    <HostHarnessConfigurationFields editor={draft.editor} issues={form.issues} onChange={editor => form.setDraft(current => current && ({ ...current, editor }))} />
    <SettingsFormFeedback form={form} />
    <p className="computer-hint">Saving does not qualify this computer. New admissions still need current installation and qualification evidence.</p>
    {value ? <HostHarnessProfileCheck key={value.instanceId} value={value} draftDirty={form.isDirty || form.isSaving || form.uncertain} /> : null}
    <SettingsFormActions form={{ ...form, isDirty: Boolean(seed) || form.isDirty, reset: seed ? () => onCancelled?.() : form.reset }} saveLabel={value ? 'Save host override' : 'Create host override'} onSave={submit} />
  </section>
}
export function HostHarnessOverrides({ target }: { target: HostHarnessOverrideListInput }) {
  const generation = sessionGeneration()
  useEffect(() => {
    const signal = sessionSignal()
    const clear = () => useCreation.setState({ seeds: {}, selections: {} })
    signal.addEventListener('abort', clear, { once: true })
    return () => signal.removeEventListener('abort', clear)
  }, [generation])
  const overrides = useHostHarnessOverridesQuery(target)
  const inventory = useHostHarnessRegistryQuery(target.hostRef, target.applicationInstallationId)
  const scope = `${generation}:${JSON.stringify(target)}`
  const seed = useCreation(state => state.seeds[scope])
  const selection = useCreation(state => state.selections[scope])
  const select = useCreation(state => state.select)
  const put = useCreation(state => state.put)
  if (overrides.isPending) return <LoadingState label="Loading host instance settings…" />
  if (overrides.isError) return <><Alert title="Host instance settings could not be read." tone="warning" /><Button onClick={() => void overrides.refetch()}>Retry host settings</Button></>
  const choices = inventory.isSuccess ? inventory.data.installations.filter(installation => installation.installed && installation.installationFingerprint !== null).flatMap(installation => inventory.data.instances.filter(preset => preset.availability === 'available' && preset.configuration && preset.driverId === installation.driverId)
    .map(preset => ({ installation, preset, id: JSON.stringify([installation.harnessInstallationId, installation.installationFingerprint, preset.instanceId, preset.instanceRevision]) }))) : []
  const selected = choices.find(choice => choice.id === selection)
  return <section aria-label="Host instance settings"><h2>Host instance settings</h2>
    {overrides.data.overrides.map(value => <OverrideEditor key={`${value.instanceId}:${value.target.installationFingerprint}`} value={value} />)}
    {!overrides.data.overrides.length ? <p>No overrides yet. This computer uses the global presets until you create one.</p> : null}
    {seed ? <OverrideEditor key={seed.instanceId} seed={seed} onCreated={() => put(scope)} onCancelled={() => put(scope)} /> : <>
      <Select label="Installation and global preset for new override" value={selection ?? ''} options={[{ value: '', label: 'Choose an installation and preset' }, ...choices.map(choice => ({ value: choice.id, label: `${choice.preset.driverId} · ${choice.installation.harnessInstallationId} · ${choice.preset.instanceId}` }))]}
        onChange={event => select(scope, event.target.value)} />
      <Button disabled={!selected || !selected.preset.configuration || !selected.installation.installationFingerprint} onClick={() => {
        if (!selected?.preset.configuration || !selected.installation.installationFingerprint) return
        put(scope, { instanceId: crypto.randomUUID(), target: { ...target, harnessInstallationId: selected.installation.harnessInstallationId, installationFingerprint: selected.installation.installationFingerprint },
          presetId: selected.preset.instanceId, value: { enabled: true, editor: createHarnessEditor(selected.preset.configuration) } })
      }}>Configure new host override</Button>
      {inventory.isError ? <Alert tone="danger" title="Installation choices could not be read. Reload this computer to try again." /> : null}
      {inventory.isSuccess && !choices.length ? <p className="computer-hint">No installed harness with an available global preset was reported for this computer, so there is nothing to override yet.</p> : null}
      <p className="computer-hint">Creating an override copies the preset’s values for this computer. Login files and credentials are not copied.</p>
    </>}
  </section>
}
