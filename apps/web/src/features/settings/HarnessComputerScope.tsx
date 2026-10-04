import type { ReactNode } from 'react'
import { useSelectedMainQuery, useRegisteredComputersQuery, useHostHarnessRegistryQuery } from '../../shared/api/computerSettings'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, LoadingState, Select } from '../../shared/ui/nocturne'
import type { HostHarnessOverrideListInput } from '@foreman-code/contracts/harness-registry'
import { HostHarnessInventory } from './HostHarnessInventory'
import { HostHarnessOverrides } from './HostHarnessOverrides'
import { compactIdentity } from '../../shared/ui/compactIdentity'

function HostSettings({ target }: { target: HostHarnessOverrideListInput }) {
  const inventory = useHostHarnessRegistryQuery(target.hostRef, target.applicationInstallationId)
  return <>
    {inventory.isPending ? <LoadingState label="Loading selected computer inventory…" /> : inventory.isError ? <Alert tone="danger" title="Selected computer inventory could not be read." />
      : <HostHarnessInventory host={target.hostRef} registry={inventory.data} />}
    <HostHarnessOverrides target={target} />
  </>
}
export function HarnessComputerScope({ selectedComputer, onSelectComputer, children }: {
  selectedComputer?: string; onSelectComputer(computer: string | undefined): void; children: ReactNode;
}) {
  const main = useSelectedMainQuery()
  const currentMain = main.isSuccess ? main.data : undefined
  const computers = useRegisteredComputersQuery(currentMain?.mainId)
  const registration = computers.isSuccess ? computers.data.devices.find(value => value.deviceId === selectedComputer) : undefined
  const deviceIds = computers.data?.devices.map(value => value.deviceId) ?? []
  const target: HostHarnessOverrideListInput | undefined = currentMain && (selectedComputer === 'main'
    ? { hostRef: { kind: 'main', mainId: currentMain.mainId }, applicationInstallationId: currentMain.mainId }
    : registration?.status === 'paired' ? { hostRef: { kind: 'device', mainId: currentMain.mainId, deviceId: registration.deviceId }, applicationInstallationId: registration.workerInstallationId } : undefined)
  return <div className="settings-editor-page">
    <Select label="Settings scope" value={selectedComputer ?? ''} options={[{ value: '', label: 'Global presets · existing API-host connections' },
      ...(selectedComputer && selectedComputer !== 'main' && !registration ? [{ value: selectedComputer, label: `Computer ${compactIdentity(selectedComputer, deviceIds)} · unverified`, disabled: true }] : []),
      ...(currentMain ? [{ value: 'main', label: 'Main' }] : []),
      ...(computers.isSuccess ? computers.data.devices.map(value => ({ value: value.deviceId, label: `Computer ${compactIdentity(value.deviceId, deviceIds)} · ${value.status}`, disabled: value.status !== 'paired' })) : [])]}
      onChange={event => onSelectComputer(event.target.value || undefined)} />
    {selectedComputer && (currentMain || selectedComputer !== 'main') ? <details className="computer-details"><summary>Selected computer identity</summary><dl className="computer-facts">
      {currentMain ? <div><dt>Main</dt><dd>{currentMain.mainId}</dd></div> : null}
      {selectedComputer !== 'main' ? <div><dt>Device</dt><dd>{selectedComputer}</dd></div> : null}
      {registration ? <><div><dt>Application installation</dt><dd>{registration.workerInstallationId}</dd></div><div><dt>Registration</dt><dd>{registration.status}</dd></div></> : null}
    </dl></details> : null}
    {!selectedComputer ? children : target ? <HostSettings key={`${sessionGeneration()}:${JSON.stringify(target)}`} target={target} />
      : main.isPending || Boolean(currentMain && selectedComputer !== 'main' && computers.isPending) ? <LoadingState label="Reading selected computer authority…" /> : <Alert tone="danger" title="This computer is unavailable or access is not authorized. Global presets were not selected as a replacement." />}
  </div>
}
