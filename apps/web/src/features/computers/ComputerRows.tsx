import { useRef } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Monitor, Minus, Plus } from 'lucide-react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import { computerDisplayName, type ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useBuildComputers } from '../../shared/api/buildComputers'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerAccounts } from '../../shared/api/computerAccounts'
import { ComputerAccountChips } from './ComputerAccounts'
import { GitHubSignInDialog } from './GitHubSignIn'
import { DriveConnectDialog } from './DriveConnect'
import { Alert, Button, IconButton, LoadingState, Switch, Select } from '../../shared/ui/nocturne'
import { computerState } from './computerState'
import { ComputerUtilization } from './ComputerUtilization'
import { useComputerUi } from './computerUiStore'
import { computerEditError, preferenceEdit, reorderEdits, useComputerEdits, type ComputerPreferencePatch } from './useComputerEdits'
import './computers.css'

export function ComputerRows({ mainId, devices, onSelectComputer }: {
  mainId: string; devices: DeviceRegistration[]; onSelectComputer?: ((deviceId: string) => void) | undefined
}) {
  const targets: DeviceProvisioningTarget[] = [{ hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }, ...devices.filter(device => device.status === 'paired').map(device => ({
    hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId },
    applicationInstallationId: device.workerInstallationId, keyRevision: device.keyRevision,
    authorizationRevision: device.authorizationRevision,
  }))]
  const reads = useBuildComputers(targets)
  const activity = useComputerActivity()
  const accounts = useComputerAccounts()
  const openGitHub = useComputerUi(state => state.openGitHub)
  const openDrive = useComputerUi(state => state.openDrive)
  const save = useComputerEdits(mainId)
  const dragSnapshot = useRef<BuildComputerStatus[]>([])
  const drag = useComputerUi(state => state.drag)
  const draggedKey = useComputerUi(state => state.draggedKey)
  const rows = targets.map((target, index) => ({ target, read: reads[index]! }))
    // Same order Auto placement uses: every Primary before any Backup, then priority.
    .sort((a, b) => Number(a.read.data?.preference.buildRole === 'backup') - Number(b.read.data?.preference.buildRole === 'backup')
      || (b.read.data?.preference.buildPriority ?? 50) - (a.read.data?.preference.buildPriority ?? 50)
      || computerKey(a.target).localeCompare(computerKey(b.target)))
  const canReorder = rows.every(row => row.read.isSuccess) && !save.locked
    && rows.length <= 101
  const move = (key: string, destination: string) => {
    const sourceExists = rows.some(row => computerKey(row.target) === key)
    const destinationExists = rows.some(row => computerKey(row.target) === destination)
    if (!sourceExists || !destinationExists) {
      drag()
      dragSnapshot.current = []
      return
    }
    if (!canReorder) return
    const statuses = draggedKey && dragSnapshot.current.length ? dragSnapshot.current : rows.map(row => row.read.data!)
    const edits = reorderEdits(statuses, statuses.findIndex(row => computerKey(row.preference.target) === key),
      statuses.findIndex(row => computerKey(row.preference.target) === destination))
    if (edits.length) save.mutate(edits)
    drag()
  }
  return <>
    <p className="computer-list-caption">Auto placement · Top priority first · Primary before Backup</p>
    {save.uncertain ? <Alert tone="warning" title="The save is unconfirmed. Retry the original save before making more changes.">
      <Button size="sm" onClick={save.retry}>Retry original save</Button>
    </Alert> : save.isError && <Alert tone="danger" title={computerEditError(save.error)} />}
    {save.storageError && <Alert tone="danger" title={save.storageError}>
      <Button size="sm" onClick={save.retryStorage}>Retry save recovery</Button>
    </Alert>}
    {activity.isError && <div className="computer-list-feedback"><span>Activity unavailable</span>
      <Button size="sm" variant="ghost" onClick={() => void activity.refetch()}>Retry activity</Button></div>}
    <ul className="computer-priority-list" aria-label="Computers in build priority order" aria-busy={save.isPending}>
      {rows.map(({ target, read }, index) => {
        const key = computerKey(target)
        const observed = activity.data?.mainId === mainId && !activity.isError
          ? activity.data.computers.find(computer => computerKey(computer.target) === key) : undefined
        return <li key={key} className="computer-priority-row" aria-label={observed?.name ?? computerName(target)}
          data-dragging={draggedKey === key || undefined}
          onDragOver={event => { if (canReorder && draggedKey) event.preventDefault() }}
          onDrop={event => {
            event.preventDefault()
            if (draggedKey) move(draggedKey, key)
          }}>
          <div className="computer-reorder">
            <span draggable={canReorder} className="computer-drag-handle" title="Drag to reorder" aria-hidden="true"
              onDragStart={event => {
                if (!canReorder) { event.preventDefault(); return }
                dragSnapshot.current = rows.map(row => row.read.data!)
                drag(key)
                event.dataTransfer.setData('text/plain', key)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => { drag(); dragSnapshot.current = [] }}><GripVertical size={16} /></span>
            <div><IconButton label={`Move ${computerName(target)} up`} variant="ghost" size="sm"
              disabled={!canReorder || index === 0} onClick={() => move(key, computerKey(rows[index - 1]!.target))}><ArrowUp size={12} /></IconButton>
              <IconButton label={`Move ${computerName(target)} down`} variant="ghost" size="sm"
                disabled={!canReorder || index === rows.length - 1} onClick={() => move(key, computerKey(rows[index + 1]!.target))}><ArrowDown size={12} /></IconButton></div>
          </div>
          <ComputerRowIdentity target={target} computer={observed} complete={activity.data?.activityComplete ?? false} />
          {read.isPending && <LoadingState label="Loading build settings…" />}
          {read.isError && <Button size="sm" onClick={() => void read.refetch()}>Retry build settings</Button>}
          {read.data && !read.isError && <ComputerControls status={read.data} name={computerName(target)}
            disabled={save.locked} onEdit={patch => save.mutate([preferenceEdit(read.data!, patch)])} />}
          <ComputerAccountChips accounts={accounts.data?.computers.find(computer => computerKey(computer.target) === key)?.accounts}
            onGitHub={() => openGitHub(key)} onDrive={() => openDrive(key)} />
          <GitHubSignInDialog target={target} name={computerName(target)} account={accounts.data?.computers
            .find(computer => computerKey(computer.target) === key)?.accounts?.accounts.find(value => value.tool === 'github')} />
          <DriveConnectDialog target={target} name={computerName(target)} account={accounts.data?.computers
            .find(computer => computerKey(computer.target) === key)?.accounts?.accounts.find(value => value.tool === 'drive')} />
          <ComputerUtilization target={target} online={observed?.online ?? false} />
          {target.hostRef.kind === 'device' && onSelectComputer && <IconButton label={`Open ${computerName(target)}`}
            variant="ghost" size="sm" onClick={() => {
              if (target.hostRef.kind === 'device') onSelectComputer(target.hostRef.deviceId)
            }}><ChevronRight size={16} /></IconButton>}
        </li>
      })}
      {devices.filter(device => device.status !== 'paired').map(device => <li key={device.deviceId}
        className="computer-priority-row computer-registration-row">
        <Monitor size={18} aria-hidden="true" /><strong>{computerDisplayName({ kind: 'device', deviceId: device.deviceId })}</strong>
        <span>{device.status === 'pending' ? 'Pairing pending' : 'Access revoked'}</span>
        {onSelectComputer && <Button size="sm" variant="ghost" onClick={() => onSelectComputer(device.deviceId)}>Open</Button>}
      </li>)}
    </ul>
    {!devices.some(device => device.status === 'paired') && <p className="computer-list-caption">Add a computer to share builds and agents.</p>}
  </>
}
function computerName(target: DeviceProvisioningTarget) {
  return computerDisplayName(target.hostRef)
}
function ComputerRowIdentity({ target, computer, complete }: {
  target: DeviceProvisioningTarget; computer: ComputerActivity | undefined; complete: boolean
}) {
  const open = useComputerUi(state => state.openActivity)
  const presenceLabel = computer && (computer.online ? 'Online' : 'Offline')
  return <button className="computer-row-identity" onClick={() => open(computerKey(target))} disabled={!computer}
    aria-label={`Activity on ${computerName(target)}`}>
    <Monitor size={20} aria-hidden="true" />
    <span><strong>{computer?.name ?? computerName(target)}</strong>
      <span className="computer-live-state"><span className="computer-presence-dot" data-online={computer?.online}
        title={presenceLabel ?? 'Presence unavailable'} aria-hidden="true" />{computerState(computer, complete)}</span>
    </span>
  </button>
}
function ComputerControls({ status, name, disabled, onEdit }: {
  status: BuildComputerStatus; name: string; disabled: boolean;
  onEdit: (patch: ComputerPreferencePatch) => void
}) {
  const preference = status.preference
  return <div className="computer-row-controls">
    <Select className="computer-role-chip" label={`Build role for ${name}`} disabled={disabled}
      value={preference.buildRole} onChange={event => onEdit({ buildRole: event.target.value as 'primary' | 'backup' })}
      options={[{ value: 'primary', label: 'Primary' }, { value: 'backup', label: 'Backup' }]} />
    <Switch className="computer-build-switch" label="Builds" aria-label={`Builds on ${name}`}
      checked={preference.buildEnabled} disabled={disabled} onChange={event => onEdit({ buildEnabled: event.target.checked })} />
    <div className="computer-allowance" role="group" aria-label={`Build allowance for ${name}`} title="CPU and memory available to builds">
      <IconButton variant="ghost" size="sm" label={`Decrease allowance for ${name}`}
        disabled={disabled || preference.buildAllowancePercent <= 10}
        onClick={() => onEdit({ buildAllowancePercent: Math.max(10, preference.buildAllowancePercent - 10) })}><Minus size={12} /></IconButton>
      <output aria-label={`Allowance for ${name}`}>{preference.buildAllowancePercent}%</output>
      <IconButton variant="ghost" size="sm" label={`Increase allowance for ${name}`}
        disabled={disabled || preference.buildAllowancePercent >= 100}
        onClick={() => onEdit({ buildAllowancePercent: Math.min(100, preference.buildAllowancePercent + 10) })}><Plus size={12} /></IconButton>
    </div>
    {status.state === 'setup-required' && <span className="computer-setup-note" title={status.reasons.join(' ')}>Setup needed</span>}
  </div>
}
