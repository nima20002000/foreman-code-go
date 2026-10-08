import { retiredHarnessLabel } from './settingsPresentation'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { HarnessRegistryReadback, HostHarnessInstallationDto } from '@foreman-code/contracts/harness-registry'
import { Alert } from '../../shared/ui/nocturne'
import { ComputerPresence } from './ComputerPresence'
import './computerSettings.css'

function sameComputer(left: CanonicalMachineReference, right: CanonicalMachineReference) {
  return left.mainId === right.mainId && left.kind === right.kind
    && (left.kind === 'main' || (right.kind === 'device' && left.deviceId === right.deviceId))
}
function observed(value: boolean | null) { return value === null ? 'Unknown' : value ? 'Yes' : 'No' }
function Installation({ value }: { value: HostHarnessInstallationDto }) {
  if (value.driverId === 'opencode') return <section className="computer-inventory-item">
    <p role="status">{retiredHarnessLabel}</p><p>{value.observedVersion ?? 'Version unknown'}</p>
  </section>
  return <section className="computer-inventory-item" aria-label={`${value.driverId} installation`}>
    <h3>{value.driverId} <small>{value.observedVersion ? `version ${value.observedVersion}` : 'version unknown'}</small></h3>
    <dl className="computer-checks">
      <div data-state={value.installed === null ? 'unknown' : value.installed ? 'yes' : 'no'}><dt>Installed</dt><dd>{observed(value.installed)}</dd></div>
      <div data-state={value.authenticated === null ? 'unknown' : value.authenticated ? 'yes' : 'no'}><dt>Authenticated</dt><dd>{observed(value.authenticated)}</dd></div>
      <div data-state={value.compatible === null ? 'unknown' : value.compatible ? 'yes' : 'no'}><dt>Compatible</dt><dd>{observed(value.compatible)}</dd></div>
      <div data-state={value.qualified === null ? 'unknown' : value.qualified ? 'yes' : 'no'}><dt>Qualified</dt><dd>{observed(value.qualified)}</dd></div>
    </dl>
    {value.launcher.diagnostics.length ? <ul className="computer-diagnostics">{value.launcher.diagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
    <details className="computer-details"><summary>Installation details</summary>
      <dl className="computer-facts">
        <div><dt>Fingerprint</dt><dd>{value.installationFingerprint ?? 'Unavailable'}</dd></div>
        <div><dt>Checked</dt><dd><time dateTime={value.launcher.checkedAt}>{value.launcher.checkedAt}</time></dd></div>
        <div><dt>Harness installation</dt><dd>{value.harnessInstallationId}</dd></div>
        <div><dt>Executable</dt><dd>{value.launcher.resolvedLauncher ?? 'Unavailable'} · {value.launcher.status}</dd></div>
        <div><dt>Environment</dt><dd>{value.launcher.environment.provenance} · {value.environmentGeneration}</dd></div>
        <div><dt>Connection generation</dt><dd>{value.connectionGeneration}</dd></div>
        <div><dt>Driver / protocol revision</dt><dd>{value.driverRevision} / {value.protocolRevision}</dd></div>
      </dl>
    </details>
  </section>
}
/** A projection of the authenticated registry readback; it never discovers or launches a harness. */
export function HostHarnessInventory({ host, registry }: { host: CanonicalMachineReference; registry: HarnessRegistryReadback }) {
  const installations = registry.installations.filter((value) => sameComputer(value.hostRef, host))
  return <section aria-label="Host harness inventory">
    {registry.hostMetadata && sameComputer(registry.hostMetadata.hostRef, host) ? <>
      <h2 className="computers-title">Computer environment</h2>
      <dl className="computer-facts computer-facts--status"><div><dt>Platform</dt><dd>{registry.hostMetadata.platform ? `${registry.hostMetadata.platform.platform} · ${registry.hostMetadata.platform.architecture}` : 'Unknown or restricted'}</dd></div></dl>
      <ComputerPresence host={host} applicationInstallationId={registry.hostMetadata.applicationInstallationId} metadata={registry.hostMetadata} />
      <details className="computer-details"><summary>Technical details</summary>
        <dl className="computer-facts"><div><dt>Application installation</dt><dd>{registry.hostMetadata.applicationInstallationId}</dd></div></dl></details>
      <h3>Permitted workspace roots</h3>
      {registry.hostMetadata.workspaceRoots === null ? <p>Root policy readback is unknown or restricted. No permitted roots are inferred.</p>
        : registry.hostMetadata.workspaceRoots.length ? <ul className="computer-instance-list">{registry.hostMetadata.workspaceRoots.map(root => <li key={root.rootId}>
          {root.rootPath}<span>{root.accessMode} · workspace {root.workspaceId} · policy {root.rootPolicyId} revision {root.rootPolicyRevision}</span></li>)}</ul>
          : <p>No permitted workspace roots were returned.</p>}
    </> : <p>Computer environment metadata is unavailable.</p>}
    <h2 className="computers-title">Harness installations</h2>
    <p className="computer-hint">Installed, signed in, compatible and qualified are separate checks. None of them proves a live session. “Unknown” means no result was reported: not checked, or unavailable.</p>
    {installations.length ? installations.map((value) => <Installation key={value.harnessInstallationId} value={value} />)
      : <Alert title="No harness installation evidence was returned for this computer." tone="warning" />}
    <details className="computer-details"><summary>Global defaults ({registry.instances.length})</summary>
      <h2 className="computers-title">Global configured instances</h2>
      <p className="computer-hint">Global presets are defaults for every computer, not installations. Existing sessions keep the revision they started with.</p>
      {registry.instances.length ? <ul className="computer-instance-list">{registry.instances.map((value) => <li key={value.instanceId}>
        <strong>{value.driverId === 'opencode' ? retiredHarnessLabel : value.driverId}</strong> · {value.instanceId} · revision {value.instanceRevision}
        <span>{value.enabled ? value.availability : 'disabled'}</span>
      </li>)}</ul> : <p>No configured instances were returned.</p>}
    </details>
  </section>
}
