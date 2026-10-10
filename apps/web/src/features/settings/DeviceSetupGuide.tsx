import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'

/** Static guidance shown before a request code exists. It never installs, logs in or changes a network. */
export function DeviceSetupGuide() {
  return <section className="device-setup-guide" aria-label="Before you add a computer">
    <h3>Before you add a computer</h3>
    <ol className="computer-steps">
      <li><strong>Install the companion on the remote computer first.</strong> Its request code only exists after the companion is installed and opened there.</li>
      <li><strong>Pair it here.</strong> Pairing lets the computer connect and send heartbeats to this main. It does not allow remote commands.</li>
      <li><strong>Approve remote commands separately.</strong> A person must approve running commands as the selected operating-system user. Pairing never counts as that approval.</li>
      <li><strong>Check connection readiness.</strong> Readiness comes from a verified connection, not from registration or inventory.</li>
    </ol>
    <details className="computer-details"><summary>Network prerequisites</summary>
      <ul className="computer-diagnostics">
        <li>SSH and rsync must already be installed and working on the remote computer.</li>
        <li>The remote computer must be reachable from this main over your LAN or, optionally, over Tailscale.</li>
        <li>If you use Tailscale, install it and sign in yourself on each computer; this page does not install it or change network settings.</li>
        <li>Compare the computer and main fingerprints shown when you confirm details. Do not approve if they differ from what each machine displays.</li>
      </ul>
    </details>
  </section>
}

/** Pairing alone cannot establish whether remote commands are approved or ready. */
export function ConnectionSetupStatus({ registration }: { registration: DeviceRegistration }) {
  const state = registration.status === 'revoked' ? 'blocked' : registration.status === 'paired' ? 'unverified' : 'needs-pairing'
  return <section className="device-setup-status" aria-label="Remote command connection" data-state={state}>
    <h3>Remote command connection</h3>
    <p role="status">{registration.status === 'revoked'
      ? <><strong>Blocked.</strong> This computer’s registration is revoked, so no connection can be set up.</>
      : registration.status === 'paired'
        ? <><strong>Connection status unverified.</strong> This computer is paired. Ask the Operator to read its current remote-command approval and check the connection.</>
        : <><strong>Pairing needed.</strong> Pair this computer before any connection can be set up.</>}</p>
    <p className="computer-hint">Running commands as the selected operating-system user needs a separate owner approval.
      This page does not display or request that approval, and pairing does not substitute for it.</p>
    <ul className="computer-diagnostics">
      <li>Remote-command approval does not give any agent permissions; read-only agents stay read-only.</li>
      <li>It never uses sudo or root automatically, skips SSH host-key checks, or stores hidden credentials.</li>
    </ul>
  </section>
}
