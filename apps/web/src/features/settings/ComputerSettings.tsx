import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import type { CanonicalMachineReference, DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { ComputerRows } from '../computers/ComputerRows'
import { useRuntimeIdentityQuery } from '../../shared/api/runtimeIdentity'
import { useHostHarnessRegistryQuery, useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'
import { ComputerRevokeButton } from './ComputerRevokeButton'
import { ComputerRuntimeQualification } from '../runtime-qualification/ComputerRuntimeQualification'
import { ComputerPairingForm } from './ComputerPairingForm'
import { ConnectionSetupStatus } from './DeviceSetupGuide'
import { HostHarnessOverrides } from './HostHarnessOverrides'
import { HostHarnessInventory } from './HostHarnessInventory'
import { BuildComputerParticipation } from './BuildComputerParticipation'
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
  return <section className="settings-editor-page computers-page" aria-label={deviceId ? 'Computer details' : 'Computers'}>
    <header className="computers-header"><div className="settings-experience-heading"><h1>{deviceId ? 'Computer details' : 'Computers'}</h1>
      <p>Builds and agents, across your computers.</p></div>
      {currentMain ? <Button variant="primary" aria-expanded={adding} aria-controls="computer-add-panel" onClick={() => toggleAdd(`${sessionGeneration()}:${currentMain.mainId}`)}>{adding ? 'Close' : 'Add computer'}</Button> : null}</header>
    {currentMain ? <div id="computer-add-panel" className="computers-panel" hidden={!adding}><ComputerPairingForm key={currentMain.mainId} mainId={currentMain.mainId} /></div>
      : <p className="computer-hint">Read the selected main before adding a computer.</p>}
    <h2 className="computers-title">{deviceId ? 'Worker registration' : 'Your computers'}</h2>
    {deviceId ? !currentMain ? <p>Read the selected main before inspecting workers.</p> : computers.isPending ? <LoadingState label="Loading registered computers…" />
      : computers.isError ? <><Alert tone="danger" title="Registered computers could not be read." /><Button onClick={() => void computers.refetch()}>Retry registered computers</Button></>
        : registration ? <><RegistrationFacts registration={registration} /><ComputerRevokeButton key={`${registration.mainId}:${registration.deviceId}`} registration={registration} />
          {registration.status === 'paired' ? <ComputerRuntimeQualification key={`runtime:${registration.mainId}:${registration.deviceId}`} registration={registration} /> : null}</> : <Alert tone="warning" title="This device is not registered with the selected main." />
      : main.isError ? <><Alert tone="danger" title="Main PC could not be read." />
        <Button onClick={() => void main.refetch()}>Retry Main PC</Button></>
      : !currentMain ? <LoadingState label="Loading Main PC…" />
        : computers.isPending ? <LoadingState label="Loading computers…" />
          : computers.isError ? <><Alert tone="danger" title="Computers could not be read." />
            <Button onClick={() => void computers.refetch()}>Retry computers</Button></>
            : <ComputerRows mainId={currentMain.mainId} devices={computers.data?.devices ?? []}
              onSelectComputer={onSelectComputer} />}

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
    {deviceId && host && registration?.status === 'paired' ? <BuildComputerParticipation
      key={`builds:${host.mainId}:${deviceId ?? 'main'}:${registration?.authorizationRevision ?? 0}`}
      target={{ hostRef: host, applicationInstallationId: registration?.workerInstallationId ?? host.mainId,
        keyRevision: registration?.keyRevision ?? null, authorizationRevision: registration?.authorizationRevision ?? null }} /> : null}
    <details className="computer-details" open={deviceId ? true : undefined}>
      <summary>{deviceId ? 'Computer setup' : 'Main PC setup'}</summary>
    {host && (!registration || registration.status === 'paired') ? <Inventory key={`inventory:${host.mainId}:${deviceId ?? 'main'}`} host={host} applicationInstallationId={registration?.workerInstallationId ?? host.mainId} /> : null}
    {host && (!registration || registration.status === 'paired') ? <HostHarnessOverrides key={`overrides:${host.mainId}:${deviceId ?? 'main'}`} target={{ hostRef: host, applicationInstallationId: registration?.workerInstallationId ?? host.mainId }} /> : null}
    {!deviceId ? <WorkerExecutionSettings /> : null}
    </details>
    {registration?.status === 'revoked' ? <Alert tone="warning" title="This worker’s application access is revoked." /> : null}

  </section>
}
