import type { CanonicalMachineReference } from '@graphql/contracts/device-identity'
import type { HarnessRegistryReadback, HostHarnessInstallationDto } from '@graphql/contracts/harness-registry'
import { Alert } from '../../shared/ui/nocturne'
import { ComputerPresence } from './ComputerPresence'
import './computerSettings.css'

function sameComputer(left: CanonicalMachineReference, right: CanonicalMachineReference) {
  return left.mainId === right.mainId && left.kind === right.kind
    && (left.kind === 'main' || (right.kind === 'device' && left.deviceId === right.deviceId))
}
function observed(value: boolean | null) { return value === null ? 'Unknown' : value ? 'Yes' : 'No' }
function Installation({ value }: { value: HostHarnessInstallationDto }) {
  return <section className="computer-inventory-item" aria-label={`${value.driverId} installation`}>
    <h3>{value.driverId}</h3>
    <dl className="computer-facts computer-facts--status">
      <div><dt>Installed</dt><dd>{observed(value.installed)}</dd></div>
      <div><dt>Authenticated</dt><dd>{observed(value.authenticated)}</dd></div>
      <div><dt>Compatible</dt><dd>{observed(value.compatible)}</dd></div>
      <div><dt>Qualified</dt><dd>{observed(value.qualified)}</dd></div>
      <div><dt>Version</dt><dd>{value.observedVersion ?? 'Unknown'}</dd></div>
    </dl>
    <dl className="computer-facts">
      <div><dt>Fingerprint</dt><dd>{value.installationFingerprint ?? 'Unavailable'}</dd></div>
      <div><dt>Checked</dt><dd><time dateTime={value.launcher.checkedAt}>{value.launcher.checkedAt}</time></dd></div>
    </dl>
    {value.launcher.diagnostics.length ? <ul>{value.launcher.diagnostics.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
    <details className="computer-details"><summary>Installation details</summary>
      <dl className="computer-facts">
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
      <h2>Computer environment</h2>
      <dl className="computer-facts"><div><dt>Platform</dt><dd>{registry.hostMetadata.platform ? `${registry.hostMetadata.platform.platform} · ${registry.hostMetadata.platform.architecture}` : 'Unknown or restricted'}</dd></div>
        <div><dt>Application installation</dt><dd>{registry.hostMetadata.applicationInstallationId}</dd></div></dl>
      <ComputerPresence host={host} applicationInstallationId={registry.hostMetadata.applicationInstallationId} metadata={registry.hostMetadata} />
      <h3>Permitted workspace roots</h3>
      {registry.hostMetadata.workspaceRoots === null ? <p>Root policy readback is unknown or restricted. No permitted roots are inferred.</p>
        : registry.hostMetadata.workspaceRoots.length ? <ul className="computer-instance-list">{registry.hostMetadata.workspaceRoots.map(root => <li key={root.rootId}>
          {root.rootPath}<span>{root.accessMode} · workspace {root.workspaceId} · policy {root.rootPolicyId} revision {root.rootPolicyRevision}</span></li>)}</ul>
          : <p>No permitted workspace roots were returned.</p>}
    </> : <p>Computer environment metadata is unavailable.</p>}
    <h2>Harness installations</h2>
    <p className="computer-hint">Installed, signed in, compatible and qualified are separate checks. None of them proves a live session.</p>
    {installations.length ? installations.map((value) => <Installation key={value.harnessInstallationId} value={value} />)
      : <Alert title="No harness installation evidence was returned for this computer." tone="warning" />}    <h2>Global configured instances</h2>
    <p className="computer-hint">Global presets are defaults, not installations. Existing sessions keep the revision they started with.</p>
    {registry.instances.length ? <ul className="computer-instance-list">{registry.instances.map((value) => <li key={value.instanceId}>
      <strong>{value.driverId}</strong> · {value.instanceId} · revision {value.instanceRevision}
      <span>{value.enabled ? value.availability : 'disabled'}</span>
    </li>)}</ul> : <p>No configured instances were returned.</p>}
  </section>
}
