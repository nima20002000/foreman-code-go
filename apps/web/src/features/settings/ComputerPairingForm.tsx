import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { DeviceSetupApproveInputSchema, decodeWorkerIdentityRequest } from '@graphql/contracts/device-setup'
import { useApproveComputerSetup, useComputerSetupOptionsQuery, useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { ApiError } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { TextField, Textarea, Button } from '../../shared/ui/nocturne'
import { DeviceSetupGuide } from './DeviceSetupGuide'

const unavailable = {
  'listener-unconfigured': 'This main has no computer listener configured. Configure the LAN device listener on the main, then reload this page.',
  'endpoint-unconfigured': 'This main has no LAN device address configured. Set the approved LAN device endpoint on the main, then reload this page.',
  'listener-not-started': 'The computer listener on this main is not running. Start it, then reload this page.',
} as const
const usePairingDraft = create<{ code: string; expired: boolean; expire(): void; set(code: string): void; clear(): void }>(set => ({
  code: '', expired: false,
  expire: () => set({ expired: true }),
  set: code => set({ expired: false, code }),
  clear: () => set({ expired: false, code: '' }),
}))
/** This form never installs or logs in. The private pairing code lives only in the mutation result
 * until expiry/unmount, and is never put in the URL, a query cache or persistence. */
export function ComputerPairingForm({ mainId }: { mainId: string }) {
  const code = usePairingDraft(state => state.code)
  const update = usePairingDraft(state => state.set)
  const expired = usePairingDraft(state => state.expired)
  const expire = usePairingDraft(state => state.expire)
  const clear = usePairingDraft(state => state.clear)
  const options = useComputerSetupOptionsQuery(mainId)
  const main = useSelectedMainQuery()
  const approval = useApproveComputerSetup(mainId)
  const computers = useRegisteredComputersQuery(mainId)
  const reset = approval.reset
  type Input = Omit<Parameters<typeof approval.mutateAsync>[0], 'commandId'>
  const attempt = useRef(new CommandAttempt<Input>()).current
  const original = useRef<Input | undefined>(undefined)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState<'done' | 'blocked'>()
  useEffect(() => { clear(); return () => { clear(); reset() } }, [mainId, clear, reset])
  useEffect(() => {
    if (!approval.data) return
    const timer = setTimeout(() => { reset(); expire(); setRevealed(false); setCopied(undefined) }, Math.max(0, Date.parse(approval.data.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [approval.data, reset, expire])
  const identity = (() => { try { return code.trim() ? decodeWorkerIdentityRequest(code) : undefined } catch { return null } })()
  const endpoint = options.data?.available ? options.data.endpoint : null
  const mainFingerprint = main.data?.mainId === mainId ? main.data.mainPublicKeyFingerprint : undefined
  const input: Input | undefined = identity && endpoint && mainFingerprint
    ? { identityRequestCode: code.trim(), endpoint, scopes: ['connect', 'heartbeat'] } : undefined
  const locked = approval.isPending || attempt.unresolved || Boolean(approval.data)
  const submit = async () => {
    const hadUnknownOutcome = attempt.unresolved
    try {
      const request = attempt.input(original.current ?? input!)
      DeviceSetupApproveInputSchema.parse(request)
      original.current ??= input
      await approval.mutateAsync(request)
      attempt.succeeded(); original.current = undefined
    } catch (error) {
      if (!(hadUnknownOutcome && error instanceof ApiError && (error.status === 401 || error.status === 403))) attempt.failed(error)
      if (!attempt.unresolved) original.current = undefined
    }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(approval.data!.enrollmentCode); setCopied('done') } catch { setCopied('blocked') }
  }
  const paired = approval.data && computers.data?.devices.some(value => value.deviceId === approval.data!.registration.deviceId && value.status === 'paired')
  return <section aria-label="Add computer">
    <UnsavedEditorGuard editor={{ label: 'computer pairing command', dirty: attempt.unresolved, busy: approval.isPending, uncertain: attempt.unresolved,
      save: submit, discard: () => { if (!attempt.unresolved) reset() }, error: approval.error?.message }} />
    <h2 className="computers-title">Add computer</h2>
    <DeviceSetupGuide />
    <ol className="computer-steps">
      <li>Open the installed companion on the computer and copy its request code.</li>
      <li>Paste the code here and approve the computer.</li>
      <li>Enter the private pairing code you get into the companion.</li>
    </ol>
    <p className="computer-hint">SSH connectivity does not prove application pairing. A pending computer becomes paired only after the main confirms it.</p>
    {options.isPending ? <p role="status">Reading computer setup configuration…</p> : null}
    {options.error ? <p role="alert">{options.error.message}</p> : null}
    {options.data && !options.data.available ? <div role="alert" className="computer-unavailable">
      <p>Adding a computer isn’t available yet. This main needs setup before it can accept one; the code can’t be approved until then.</p>
      <details className="computer-details"><summary>Technical details</summary>
        <p>{options.data.reason ? unavailable[options.data.reason] : 'Computer setup is unavailable.'}</p></details></div> : null}
    {main.error ? <p role="alert">{main.error.message}</p> : null}
    {main.data && main.data.mainId !== mainId ? <p role="alert">The selected main changed. Reload this page.</p> : null}
    <Textarea label="Computer request code" value={code} disabled={locked} autoComplete="off" spellCheck={false} onChange={event => update(event.target.value)} />
    {identity === null ? <p role="alert">This is not a valid computer request code. Copy it again from the companion.</p> : null}
    {identity && !approval.data ? <details className="computer-details" open>
      <summary>Confirm details</summary>
      <dl className="computer-facts">
        <div><dt>Computer ID</dt><dd>{identity.workerInstallationId}</dd></div>
        <div><dt>Computer key fingerprint</dt><dd>{identity.publicKeyFingerprint}</dd></div>
        <div><dt>This main · fingerprint</dt><dd>{mainFingerprint ?? 'Reading…'}</dd></div>
        <div><dt>Device endpoint</dt><dd>{endpoint ?? 'Unavailable'}</dd></div>
        <div><dt>Access</dt><dd>Connect and heartbeat only. This does not approve remote commands.</dd></div>
      </dl>
    </details> : null}
    {expired ? <p role="status">The one-use pairing code expired. Read the computer status before requesting a fresh code.</p> : null}
    {approval.error ? <p role="alert">{approval.error.message}</p> : null}
    {!approval.data ? <div className="computer-actions"><Button variant="primary" disabled={approval.isPending || !input}
      onClick={() => void submit()}>{approval.isPending ? 'Approving…' : attempt.unresolved ? 'Reconcile original pairing command' : 'Approve this computer'}</Button></div> : <div className="computer-pairing-result">
      <p role="status">Computer {paired ? 'paired' : `${approval.data.registration.status}; waiting for the computer to finish pairing`}. Pairing code expires <time dateTime={approval.data.expiresAt}>{approval.data.expiresAt}</time>.</p>
      {paired ? null : <>
        <TextField label="Private pairing code · secret" type={revealed ? 'text' : 'password'} readOnly autoComplete="off" value={approval.data.enrollmentCode} />
        <div className="computer-actions"><Button onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide pairing code' : 'Show pairing code'}</Button>
        <Button onClick={() => void copy()}>Copy pairing code</Button></div>
        {copied ? <p role="status">{copied === 'done' ? 'Copied. Paste it into the companion.' : 'Copy was blocked. Show the code and copy it manually.'}</p> : null}
        <p>Paste this code into the companion. Keep it out of screenshots and logs.</p>
      </>}
      <Button onClick={() => { reset(); clear(); setRevealed(false); setCopied(undefined) }}>{paired ? 'Done' : 'Discard pairing code'}</Button>
    </div>}
  </section>
}
