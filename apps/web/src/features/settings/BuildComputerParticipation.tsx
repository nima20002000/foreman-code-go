import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import { useBuildComputer, useUpdateBuildComputer } from '../../shared/api/buildComputers'
import { Alert, Button, Checkbox, LoadingState, TextField } from '../../shared/ui/nocturne'
import { useRevisionedForm } from './revisionedForm'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'

const stateLabels: Record<BuildComputerStatus['state'], string> = {
  disabled: 'Disabled', ready: 'Ready', busy: 'Busy', offline: 'Offline', 'setup-required': 'Setup required',
}
function BuildPreferenceEditor({ status }: { status: BuildComputerStatus }) {
  const { preference } = status
  const form = useRevisionedForm({ revision: preference.revision,
    value: { buildEnabled: preference.buildEnabled, buildPriority: preference.buildPriority } },
  `settings:build-computer:${JSON.stringify(preference.target)}`)
  const save = useUpdateBuildComputer()
  const draft = form.draft
  if (!draft) return <LoadingState label="Loading build preference…" />
  const submit = () => form.save(async input => {
    const result = await save.mutateAsync({ target: preference.target, commandId: input.commandId,
      expectedRevision: input.expectedRevision, ...input.value })
    return { revision: result.preference.revision,
      value: { buildEnabled: result.preference.buildEnabled, buildPriority: result.preference.buildPriority } }
  })
  const locked = form.isSaving || form.uncertain
  return <>
    <p role="status">{stateLabels[status.state]}{status.reasons.length ? ` · ${status.reasons.join(' ')}` : ''}</p>
    {!status.remoteExecutionEnabled && <Alert title="Remote execution disabled on Main" tone="warning">
      Participation is saved separately. Main’s startup execution setting must also be enabled to launch remote builds.
    </Alert>}
    <Checkbox label="Enable builds on this computer" checked={draft.buildEnabled} disabled={locked}
      onChange={event => form.setDraft(current => current && ({ ...current, buildEnabled: event.target.checked }))} />
    <TextField label="Build priority" type="number" min={0} max={100} step={1} value={draft.buildPriority} disabled={locked}
      hint="0–100. Higher priorities are preferred among ready computers with capacity."
      onChange={event => form.setDraft(current => current && ({ ...current, buildPriority: Number(event.target.value) }))} />
    <SettingsFormFeedback form={form} />
    <SettingsFormActions form={form} onSave={submit} saveLabel="Save build settings" />
  </>
}
export function BuildComputerParticipation({ target }: { target: DeviceProvisioningTarget }) {
  const read = useBuildComputer(target)
  return <section aria-label="Build participation"><h2 className="computers-title">Builds</h2>
    <p className="computer-hint">Auto Jobs use participating computers with an approved workspace root and qualified CI runtime.
      Changing priority affects future Jobs. Disabling builds leaves running Jobs available to stop and read.</p>
    {read.isPending ? <LoadingState label="Loading build settings…" /> : read.isError ? <>
      <Alert title="Build settings could not be read" tone="danger" />
      <Button onClick={() => void read.refetch()}>Retry build settings</Button>
    </> : <BuildPreferenceEditor status={read.data} />}
  </section>
}
export function BuildComputerSummary({ target }: { target: DeviceProvisioningTarget }) {
  const read = useBuildComputer(target)
  if (!read.data) return <span>Build status {read.isError ? 'unavailable' : 'loading…'}</span>
  return <span>Builds: {stateLabels[read.data.state]} · priority {read.data.preference.buildPriority}</span>
}
