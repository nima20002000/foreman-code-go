import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import type { CanonicalMachineReference, DeviceRegistration } from '@graphql/contracts/device-identity'
import { registeredComputerOptions } from '../../shared/api/computerOptions'
import { useRuntimeIdentityQuery } from '../../shared/api/runtimeIdentity'
import { useHostHarnessRegistryQuery, useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'
import { ComputerRevokeButton } from './ComputerRevokeButton'
import { ComputerRuntimeApprovals } from '../runtime-qualification/ComputerRuntimeApprovals'
import { ComputerPairingForm } from './ComputerPairingForm'
import { ConnectionSetupStatus } from './DeviceSetupGuide'
import { HostHarnessOverrides } from './HostHarnessOverrides'
import { HostHarnessInventory } from './HostHarnessInventory'
import { WorkerExecutionSettings } from './WorkerExecutionSettings'
import './computerSettings.css'

/** Which main's Add computer panel is open, keyed by session generation and main so a new session or main starts closed. */
const useAddPanel = create<{ scope?: string; toggle(scope: string): void }>(set => ({
  toggle: scope => set(state => ({ scope: state.scope === scope ? undefined : scope })),
}))
function RegistrationFacts({ registration }: { registration: DeviceRegistration }) {
  return <>
    <dl className="computer-facts computer-facts--status">
      <div><dt>Registration</dt><dd>{registration.status}</dd></div>
      <div><dt>Permitted device scopes</dt><dd>{registration.scopes.join(', ') || 'None'}</dd></div>
      <div><dt>Worker connection</dt><dd>{registration.status === 'paired' ? 'See observed connection below'
        : registration.status === 'pending' ? 'Awaiting pairing' : 'Unavailable for a revoked worker'}</dd></div>
    </dl>
    <details className="computer-details"><summary>Technical details</summary>
      <dl className="computer-facts">
        <div><dt>Device</dt><dd>{registration.deviceId}</dd></div>
        <div><dt>Worker application installation</dt><dd>{registration.workerInstallationId}</dd></div>
        <div><dt>Public key fingerprint</dt><dd>{registration.publicKeyFingerprint}</dd></div>
        <div><dt>Authorization revision</dt><dd>{registration.authorizationRevision}</dd></div>
      </dl>
    </details>
    <ConnectionSetupStatus registration={registration} />
  </>
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
  const addScope = useAddPanel(state => state.scope)
  const toggleAdd = useAddPanel(state => state.toggle)
  const adding = currentMain !== undefined && addScope === `${sessionGeneration()}:${currentMain.mainId}`
  const remote = currentMain && computers.isSuccess ? registeredComputerOptions(currentMain.mainId, computers.data.devices) : []
  return <section className="settings-editor-page computers-page" aria-label={deviceId ? 'Computer details' : 'Computers'}>
    <header className="computers-header"><div className="settings-experience-heading"><h1>{deviceId ? 'Computer details' : 'Computers'}</h1>
      <p>The machines that run your workflows, and the harnesses installed on each.</p></div>
      {currentMain ? <Button variant="primary" aria-expanded={adding} aria-controls="computer-add-panel" onClick={() => toggleAdd(`${sessionGeneration()}:${currentMain.mainId}`)}>{adding ? 'Close' : 'Add computer'}</Button> : null}</header>
    {currentMain ? <div id="computer-add-panel" className="computers-panel" hidden={!adding}><ComputerPairingForm key={currentMain.mainId} mainId={currentMain.mainId} /></div>
      : <p className="computer-hint">Read the selected main before adding a computer.</p>}
    <h2 className="computers-title">{deviceId ? 'Worker registration' : 'Your computers'}</h2>
    {deviceId ? !currentMain ? <p>Read the selected main before inspecting workers.</p> : computers.isPending ? <LoadingState label="Loading registered computers…" />
      : computers.isError ? <><Alert tone="danger" title="Registered computers could not be read." /><Button onClick={() => void computers.refetch()}>Retry registered computers</Button></>
        : registration ? <><RegistrationFacts registration={registration} /><ComputerRevokeButton key={`${registration.mainId}:${registration.deviceId}`} registration={registration} />
          {registration.status === 'paired' ? <ComputerRuntimeApprovals key={`runtime:${registration.mainId}:${registration.deviceId}`} registration={registration} /> : null}</> : <Alert tone="warning" title="This device is not registered with the selected main." />
      : <ul className="computer-rows">
        <li className="computer-row"><div className="computer-row-body"><strong>This computer</strong>
          <span>Runs the app and schedules workflows. It is not a remote worker.</span></div></li>
        {!currentMain ? <li className="computer-row computer-row--note">Read the selected main before inspecting workers.</li>
          : computers.isPending ? <li className="computer-row computer-row--note"><LoadingState label="Loading registered computers…" /></li>
            : computers.isError ? <li className="computer-row computer-row--note"><Alert tone="danger" title="Registered computers could not be read." /><Button onClick={() => void computers.refetch()}>Retry registered computers</Button></li>
              : remote.map(value => <li key={value.applicationInstallationId} className="computer-row">
                <div className="computer-row-body"><strong className="computer-row-id">{value.label}</strong>
                  <span>{value.registrationStatus === 'paired' ? 'Paired remote computer'
                    : value.registrationStatus === 'pending' ? 'Pairing pending' : 'Access revoked'} · open for its connection and installations</span></div>
                <Button size="sm" onClick={() => onSelectComputer?.(value.hostRef.deviceId)} disabled={!onSelectComputer} aria-label={`Open ${value.label}`}>Open</Button></li>)}
        {currentMain && computers.isSuccess && !remote.length ? <li className="computer-row computer-row--note">No remote computers are paired yet. Choose “Add computer” to pair one.</li> : null}
      </ul>}
    {!deviceId ? <details className="computer-details"><summary>Technical details</summary>
      <h3>Selected main · workflow authority</h3>
      {main.isPending ? <LoadingState label="Loading selected main…" /> : main.isError ? <>
        <Alert tone="warning" title="Selected-main readback is unavailable." /><Button onClick={() => void main.refetch()}>Retry selected-main readback</Button></>
        : <dl className="computer-facts"><div><dt>Main application installation</dt><dd>{main.data.mainId}</dd></div>
          <div><dt>Main application fingerprint</dt><dd>{main.data.mainPublicKeyFingerprint}</dd></div></dl>}
      <p className="computer-hint">This main schedules workflows. It cannot be switched here.</p>
      <h3>Browser connection target</h3>
      {identity.isPending ? <LoadingState label="Loading connected installation…" /> : identity.isError ? <Alert tone="danger" title="The browser’s connected installation could not be read." />
        : <dl className="computer-facts"><div><dt>API installation</dt><dd>{identity.data.installationId}</dd></div></dl>}
      <p className="computer-hint">Where this browser sends requests. It does not choose where Runs execute.</p>
    </details> : null}
    {host && (!registration || registration.status === 'paired') ? <Inventory key={`inventory:${host.mainId}:${deviceId ?? 'main'}`} host={host} applicationInstallationId={registration?.workerInstallationId ?? host.mainId} /> : null}
    {host && (!registration || registration.status === 'paired') ? <HostHarnessOverrides key={`overrides:${host.mainId}:${deviceId ?? 'main'}`} target={{ hostRef: host, applicationInstallationId: registration?.workerInstallationId ?? host.mainId }} /> : null}
    {registration?.status === 'revoked' ? <Alert tone="warning" title="This worker’s application access is revoked." /> : null}
    {!deviceId ? <WorkerExecutionSettings /> : null}
    <h2 className="computers-title">Default execution computer</h2>
    <p className="computer-hint">Pick the computer and folder in a workspace’s settings. That choice is separate from this main and the browser connection; Runs keep the placement they were accepted with.</p>
  </section>
}
