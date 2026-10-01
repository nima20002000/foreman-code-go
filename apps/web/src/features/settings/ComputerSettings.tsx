import type { CanonicalMachineReference, DeviceRegistration } from '@graphql/contracts/device-identity'
import { registeredComputerOptions } from '../../shared/api/computerOptions'
import { useRuntimeIdentityQuery } from '../../shared/api/runtimeIdentity'
import { useHostHarnessRegistryQuery, useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'
import { ComputerRevokeButton } from './ComputerRevokeButton'
import { ComputerPairingForm } from './ComputerPairingForm'
import { HostHarnessOverrides } from './HostHarnessOverrides'
import { HostHarnessInventory } from './HostHarnessInventory'
import './computerSettings.css'

function RegistrationFacts({ registration }: { registration: DeviceRegistration }) {
  return <dl className="computer-facts">
    <div><dt>Device</dt><dd>{registration.deviceId}</dd></div>
    <div><dt>Worker application installation</dt><dd>{registration.workerInstallationId}</dd></div>
    <div><dt>Public key fingerprint</dt><dd>{registration.publicKeyFingerprint}</dd></div>
    <div><dt>Registration</dt><dd>{registration.status}</dd></div>
    <div><dt>Authorization revision</dt><dd>{registration.authorizationRevision}</dd></div>
    <div><dt>Permitted device scopes</dt><dd>{registration.scopes.join(', ') || 'None'}</dd></div>
    <div><dt>Worker connection</dt><dd>{registration.status === 'paired' ? 'See observed connection below' : 'Unavailable for a revoked worker'}</dd></div>
  </dl>
}
function Inventory({ host, applicationInstallationId }: { host: CanonicalMachineReference; applicationInstallationId: string }) {
  const inventory = useHostHarnessRegistryQuery(host, applicationInstallationId)
  if (inventory.isPending) return <LoadingState label="Loading host harness inventory…" />
  if (inventory.isError) return <><Alert tone="warning" title="Host harness inventory could not be read." />
    <Button onClick={() => void inventory.refetch()}>Retry inventory readback</Button></>
  return <HostHarnessInventory host={host} registry={inventory.data} />
}
export function ComputerSettings({ deviceId, onSelectComputer }: { deviceId?: string; onSelectComputer?(deviceId: string): void }) {
  const identity = useRuntimeIdentityQuery()
  const main = useSelectedMainQuery()
  const currentMain = main.isSuccess ? main.data : undefined
  const computers = useRegisteredComputersQuery(currentMain?.mainId)
  const registration = (computers.isSuccess ? computers.data.devices : []).find(value => value.deviceId === deviceId)
  const host: CanonicalMachineReference | undefined = currentMain && (deviceId ? registration && { kind: 'device', mainId: currentMain.mainId, deviceId: registration.deviceId }
    : { kind: 'main', mainId: currentMain.mainId })
  return <section className="settings-editor-page" aria-label={deviceId ? 'Computer details' : 'Computers'}>
    <header className="settings-experience-heading"><h1>{deviceId ? 'Computer details' : 'Computers'}</h1>
      <p>Paired workers, what each computer has installed, and its harness settings.</p></header>
    <h2>Selected main · workflow authority</h2>
    {main.isPending ? <LoadingState label="Loading selected main…" /> : main.isError ? <>
      <Alert tone="warning" title="Selected-main readback is unavailable." /><Button onClick={() => void main.refetch()}>Retry selected-main readback</Button></>
      : <dl className="computer-facts"><div><dt>Main application installation</dt><dd>{main.data.mainId}</dd></div>
        <div><dt>Main application fingerprint</dt><dd>{main.data.mainPublicKeyFingerprint}</dd></div></dl>}
    <p className="computer-hint">This main schedules workflows. It cannot be switched here.</p>
    <h2>Browser connection target</h2>
    {identity.isPending ? <LoadingState label="Loading connected installation…" /> : identity.isError ? <Alert tone="danger" title="The browser’s connected installation could not be read." />
      : <dl className="computer-facts"><div><dt>API installation</dt><dd>{identity.data.installationId}</dd></div></dl>}
    <p className="computer-hint">Where this browser sends requests. It does not choose where Runs execute.</p>
    <h2>{deviceId ? 'Worker registration' : 'Registered workers'}</h2>
    {!currentMain ? <p>Read the selected main before inspecting workers.</p> : computers.isPending ? <LoadingState label="Loading registered computers…" />
      : computers.isError ? <><Alert tone="danger" title="Registered computers could not be read." /><Button onClick={() => void computers.refetch()}>Retry registered computers</Button></>
        : deviceId ? registration ? <><RegistrationFacts registration={registration} /><ComputerRevokeButton key={`${registration.mainId}:${registration.deviceId}`} registration={registration} /></> : <Alert tone="warning" title="This device is not registered with the selected main." />
          : computers.data?.devices.length ? <ul className="computer-instance-list">{registeredComputerOptions(currentMain.mainId, computers.data.devices).map(value => <li key={value.applicationInstallationId} className="computer-worker-row">
            <Button onClick={() => onSelectComputer?.(value.hostRef.deviceId)} disabled={!onSelectComputer}>{value.label}</Button>
            <span>{value.registrationStatus} · open for its connection and installations</span></li>)}</ul>
            : <p>No workers are paired with this main yet. Use “Pair a new worker” below.</p>}
    {host && (!registration || registration.status === 'paired') ? <Inventory key={`inventory:${host.mainId}:${deviceId ?? 'main'}`} host={host} applicationInstallationId={registration?.workerInstallationId ?? host.mainId} /> : null}
    {host && (!registration || registration.status === 'paired') ? <HostHarnessOverrides key={`overrides:${host.mainId}:${deviceId ?? 'main'}`} target={{ hostRef: host, applicationInstallationId: registration?.workerInstallationId ?? host.mainId }} /> : null}
    {registration?.status === 'revoked' ? <Alert tone="warning" title="This worker’s application access is revoked." /> : null}
    {currentMain ? <details className="computer-details"><summary>Pair a new worker</summary><ComputerPairingForm key={currentMain.mainId} mainId={currentMain.mainId} /></details>
      : <p className="computer-hint">Read the selected main before pairing a worker.</p>}
    <h2>Default execution computer</h2>
    <p className="computer-hint">Choose the computer and folder for a workspace in its settings. That choice is separate from the main and the browser connection, and Runs keep the placement they were accepted with.</p>
  </section>
}
