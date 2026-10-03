import { useRef } from 'react'
import type { HostHarnessOverride } from '@graphql/contracts/harness-registry'
import { useCheckHostHarnessInstance } from '../../shared/api/computerSettings'
import { ApiError } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { Button } from '../../shared/ui/nocturne'

export function HostHarnessProfileCheck({ value, draftDirty }: { value: HostHarnessOverride; draftDirty: boolean }) {
  const check = useCheckHostHarnessInstance()
  type Input = Omit<Parameters<typeof check.mutateAsync>[0], 'commandId'>
  const attempt = useRef(new CommandAttempt<Input>()).current
  const original = useRef<Input | undefined>(undefined)
  const submit = async () => {
    const hadUnknownOutcome = attempt.unresolved
    original.current ??= { instanceId: value.instanceId, expectedRevision: value.revision, target: value.target }
    try { await check.mutateAsync(attempt.input(original.current)); attempt.succeeded(); original.current = undefined }
    catch (error) {
      if (!(hadUnknownOutcome && error instanceof ApiError && (error.status === 401 || error.status === 403))) attempt.failed(error)
      if (!attempt.unresolved) original.current = undefined
    }
  }
  return <section aria-label="Saved host profile check">
    <UnsavedEditorGuard editor={{ label: 'host profile diagnostic', dirty: attempt.unresolved, busy: check.isPending, uncertain: attempt.unresolved,
      save: submit, discard: () => { if (!attempt.unresolved) check.reset() }, error: check.error?.message }} />
    <h4>Check this profile</h4>
    <p className="computer-hint">{value.driverId === 'claude'
      ? `Checks the saved profile with a short Claude conversation and disposable files. Uses ${value.configuration.harness === 'claude' && value.configuration.authMode === 'api-key' ? 'API-key billing' : 'subscription capacity'}.`
      : 'Runs native diagnostics with the saved profile.'}</p>
    <Button disabled={check.isPending || (!attempt.unresolved && (draftDirty || !value.enabled || value.qualification === 'installation-changed'))} onClick={() => void submit()}>
      {check.isPending ? 'Checking saved profile…' : attempt.unresolved ? 'Reconcile original profile check' : 'Check saved profile on this computer'}
    </Button>
    {draftDirty && !attempt.unresolved ? <p className="computer-hint">Save or discard your edits to check the saved profile.</p> : null}
    {!value.enabled && !attempt.unresolved ? <p className="computer-hint">Enable this override to check it.</p> : null}
    {value.qualification === 'installation-changed' && !attempt.unresolved ? <p className="computer-hint">The installation changed. Create a new override for the current installation to check it.</p> : null}
    {check.error ? <p role="alert">{check.error.message}</p> : null}
    {check.data && check.data.proof.instanceRevision !== value.instanceRevision ? <p role="status">This diagnostic belongs to an earlier saved revision and does not qualify the current profile.</p> : null}
    {check.data ? <>
      {check.data.proof.failure ? <p role="alert">{check.data.proof.failure.message}</p> : null}
      <dl className="computer-facts computer-facts--status">
        <div><dt>Authenticated</dt><dd>{check.data.proof.authenticated ? 'Yes' : 'No'}</dd></div>
        <div><dt>Compatible</dt><dd>{check.data.proof.compatible ? 'Yes' : 'No'}</dd></div>
        <div><dt>Qualified</dt><dd>{check.data.proof.qualified ? 'Yes' : 'No'}</dd></div>
      </dl>
      <dl className="computer-facts">
        <div><dt>Checked instance revision</dt><dd>{check.data.proof.instanceRevision}</dd></div>
        <div><dt>Native diagnostic suite</dt><dd>{check.data.proof.suiteRevision}</dd></div>
        <div><dt>Checked</dt><dd><time dateTime={check.data.proof.checkedAt}>{check.data.proof.checkedAt}</time></dd></div>
      </dl>
    </> : null}
  </section>
}
