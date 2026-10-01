import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { DevicePairingGrantInputSchema } from '@graphql/contracts/device-identity'
import { useCreateComputerPairingGrant } from '../../shared/api/computerSettings'
import { ApiError } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { TextField, Textarea, Button } from '../../shared/ui/nocturne'

type Fields = { workerInstallationId: string; publicKey: string; expectedFingerprint: string }
const usePairingDraft = create<{ fields: Fields; expired: boolean; expire(): void; set(field: keyof Fields, value: string): void; clear(): void }>(set => ({
  fields: { workerInstallationId: '', publicKey: '', expectedFingerprint: '' }, expired: false,
  expire: () => set({ expired: true }),
  set: (field, value) => set(state => ({ expired: false, fields: { ...state.fields, [field]: value } })),
  clear: () => set({ expired: false, fields: { workerInstallationId: '', publicKey: '', expectedFingerprint: '' } }),
}))
/** This form never installs or logs in. A grant lives only in the mutation result
 * until expiry/unmount, and is never put in the URL, a query cache or persistence. */
export function ComputerPairingForm({ mainId }: { mainId: string }) {
  const fields = usePairingDraft(state => state.fields)
  const update = usePairingDraft(state => state.set)
  const expired = usePairingDraft(state => state.expired)
  const expire = usePairingDraft(state => state.expire)
  const clear = usePairingDraft(state => state.clear)
  const grant = useCreateComputerPairingGrant(mainId)
  const reset = grant.reset
  type Input = Omit<Parameters<typeof grant.mutateAsync>[0], 'commandId'>
  const attempt = useRef(new CommandAttempt<Input>()).current
  const original = useRef<Input | undefined>(undefined)
  useEffect(() => { clear(); return () => { clear(); reset() } }, [mainId, clear, reset])
  useEffect(() => {
    if (!grant.data) return
    const timer = setTimeout(() => { reset(); expire() }, Math.max(0, Date.parse(grant.data.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [grant.data, reset, expire])
  const valid = DevicePairingGrantInputSchema.safeParse({ ...fields, scopes: ['connect', 'heartbeat'], commandId: 'validation-only' }).success
  const submit = async () => {
    const hadUnknownOutcome = attempt.unresolved
    const input: Input = { ...fields, scopes: ['connect', 'heartbeat'] }
    try {
      const request = attempt.input(original.current ?? input)
      DevicePairingGrantInputSchema.parse(request)
      original.current ??= input
      await grant.mutateAsync(request)
      attempt.succeeded(); original.current = undefined
    } catch (error) {
      if (!(hadUnknownOutcome && error instanceof ApiError && (error.status === 401 || error.status === 403))) attempt.failed(error)
      if (!attempt.unresolved) original.current = undefined
    }
  }
  return <section aria-label="Pair Ubuntu worker">
    <UnsavedEditorGuard editor={{ label: 'computer pairing command', dirty: attempt.unresolved, busy: grant.isPending, uncertain: attempt.unresolved,
      save: submit, discard: () => { if (!attempt.unresolved) reset() }, error: grant.error?.message }} />
    <h2>Pair Ubuntu worker</h2>
    <p>Install and sign-in approvals must be completed on the worker. Copy its public installation identity and independently verify its fingerprint before creating a one-use grant for main {mainId}.</p>
    <p>SSH connectivity does not prove application pairing. A pending registration becomes paired only after server-confirmed worker enrollment.</p>
    <TextField label="Worker application installation ID" value={fields.workerInstallationId} disabled={grant.isPending || attempt.unresolved || Boolean(grant.data)} onChange={event => update('workerInstallationId', event.target.value)} />
    <Textarea label="Worker public key" value={fields.publicKey} disabled={grant.isPending || attempt.unresolved || Boolean(grant.data)} onChange={event => update('publicKey', event.target.value)} />
    <TextField label="Verified worker public key fingerprint" value={fields.expectedFingerprint} disabled={grant.isPending || attempt.unresolved || Boolean(grant.data)} onChange={event => update('expectedFingerprint', event.target.value)} />
    {!valid && fields.workerInstallationId ? <p>Enter a valid installation UUID, public key and 64-character verified fingerprint.</p> : null}
    {expired ? <p role="status">The one-use pairing grant expired. Read the registered worker status before requesting a fresh grant.</p> : null}
    {grant.error ? <p role="alert">{grant.error.message}</p> : null}
    {!grant.data ? <Button disabled={grant.isPending || !valid}
      onClick={() => void submit()}>{grant.isPending ? 'Creating grant…' : attempt.unresolved ? 'Reconcile original pairing command' : 'Create one-use pairing grant'}</Button> : <>
      <p role="status">Registration {grant.data.registration.status}. Grant expires <time dateTime={grant.data.expiresAt}>{grant.data.expiresAt}</time>.</p>
      <TextField label="One-use grant · secret" type="password" readOnly autoComplete="off" value={grant.data.grant} />
      <p>Copy this secret into the approved worker enrollment flow. Keep it out of screenshots and logs.</p>
      <Button onClick={reset}>Hide grant</Button>
    </>}
  </section>
}
