import { useEffect, useState } from 'react'
import { ChevronRight, Monitor } from 'lucide-react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import type { ComputerAccount, ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import { computerDisplayName, type ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useBuildComputers } from '../../shared/api/buildComputers'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerAccounts } from '../../shared/api/computerAccounts'
import { useComputerMaintenance, useStartMaintenance } from '../../shared/api/computerMaintenance'
import type { ComputerMaintenanceStartInput, MaintenanceStatus } from '@foreman-code/contracts/computer-maintenance'
import { Badge, Button, IconButton } from '../../shared/ui/nocturne'
import { askOperator } from '../operator-chat/operatorChatStore'
import { MainRuntimeSetup } from '../runtime-qualification/MainRuntimeSetup'
import { ComputerUtilization } from './ComputerUtilization'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import './computerCards.css'

/** Harnesses this app runs. OpenCode is being removed and is not offered. */
const HARNESSES = [{ tool: 'codex', label: 'Codex' }, { tool: 'claude', label: 'Claude' }] as const

type Card = { target: DeviceProvisioningTarget; build: BuildComputerStatus | undefined; buildError: boolean }

/** One summary card per computer. Changes go through the Operator agent; the cards update from readback. */
export function ComputerCards({ mainId, devices, onSelectComputer, only }: {
  mainId: string; devices: DeviceRegistration[]; onSelectComputer?: ((deviceId: string) => void) | undefined
  /** Show just this paired device (its details page). */
  only?: string
}) {
  const targets: DeviceProvisioningTarget[] = [...(only ? [] : [{ hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }]), ...devices.filter(device => device.status === 'paired').map(device => ({
    hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId },
    applicationInstallationId: device.workerInstallationId, keyRevision: device.keyRevision,
    authorizationRevision: device.authorizationRevision,
  }))]
  const reads = useBuildComputers(targets)
  const activity = useComputerActivity()
  const accounts = useComputerAccounts()
  const maintenance = useComputerMaintenance()
  const start = useStartMaintenance()
  const fresh = useComputerActivityFreshness(activity.dataUpdatedAt, activity.fetchStatus)
  const cards: Card[] = targets.map((target, index) => ({ target, build: reads[index]!.data, buildError: reads[index]!.isError }))
    // The order builds use: enabled computers from the highest priority down.
    .sort((a, b) => Number(!a.build?.preference.buildEnabled) - Number(!b.build?.preference.buildEnabled)
      || (b.build?.preference.buildPriority ?? 0) - (a.build?.preference.buildPriority ?? 0)
      || computerKey(a.target).localeCompare(computerKey(b.target)))
  const builders = cards.filter(card => card.build?.preference.buildEnabled)
  return <>
    {only ? null : <div className="computer-fleet-actions" role="group" aria-label="All computers">
      <Button size="sm" disabled={start.isPending} onClick={() => {
        start.mutate([{ task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } },
          { task: { kind: 'update-system' } }])
      }}>Update computers</Button>
      <Button size="sm" variant="ghost" disabled={start.isPending} onClick={() => {
        start.mutate([{ task: { kind: 'sync-mcp' } }, { task: { kind: 'sync-plugins' } }])
      }}>Sync MCP servers and plugins</Button>
    </div>}
    {start.isError ? <small role="alert">{start.error.message}</small> : null}
    {start.data?.flatMap(result => result.computers).filter(computer => computer.error).map((computer, index) =>
      <small role="alert" key={`${computerKey(computer.target)}:${index}`}>
        {computerDisplayName(computer.target.hostRef)}: {computer.error}
      </small>)}
    <ul className="computer-card-grid" aria-label="Computers">
      {cards.map(card => {
        const observed = activity.data?.mainId === mainId && !activity.isError
          ? activity.data.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target)) : undefined
        const entry = accounts.isError ? undefined : accounts.data?.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target))
        const upkeep = maintenance.data?.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target))?.status
        return <li key={computerKey(card.target)}>
          <ComputerCard card={card} observed={observed} fresh={fresh} accounts={entry?.accounts} maintenance={upkeep}
            onMaintain={task => start.mutate({ task, targets: [card.target] })} maintaining={start.isPending}
            buildPosition={builders.indexOf(card) + 1} buildCount={builders.length}
            onOpen={card.target.hostRef.kind === 'device' && onSelectComputer
              ? () => { if (card.target.hostRef.kind === 'device') onSelectComputer(card.target.hostRef.deviceId) } : undefined} />
        </li>
      })}
      {devices.filter(device => device.status !== 'paired').map(device => <li key={device.deviceId}>
        <article className="computer-card computer-card--registration" aria-label={computerDisplayName({ kind: 'device', deviceId: device.deviceId })}>
          <header className="computer-card-header"><Monitor size={20} aria-hidden="true" />
            <h3>{computerDisplayName({ kind: 'device', deviceId: device.deviceId })}</h3>
            <Badge tone={device.status === 'pending' ? 'warning' : 'neutral'}>{device.status === 'pending' ? 'Pairing pending' : 'Access revoked'}</Badge>
          </header>
          {onSelectComputer ? <Button size="sm" variant="ghost" onClick={() => onSelectComputer(device.deviceId)}>Open</Button> : null}
        </article>
      </li>)}
    </ul>
    {only ? null : <MainRuntimeSetup />}
    {!only && !devices.some(device => device.status === 'paired') && <p className="computer-list-caption">Add a computer to share builds and agents.</p>}
  </>
}

type Task = ComputerMaintenanceStartInput['task']
function ComputerCard({ card, observed, fresh, accounts, maintenance, onMaintain, maintaining, buildPosition, buildCount, onOpen }: {
  card: Card; observed: ComputerActivity | undefined; fresh: boolean; accounts: ComputerAccounts | null | undefined
  maintenance: MaintenanceStatus | null | undefined; onMaintain(task: Task): void; maintaining: boolean
  buildPosition: number; buildCount: number; onOpen: (() => void) | undefined
}) {
  const name = observed?.name ?? computerDisplayName(card.target.hostRef)
  const task = maintenance?.tasks.find(item => item.state === 'running') ?? maintenance?.tasks[0]
  const online = fresh && observed?.online === true
  const workflows = new Set(observed?.agents.map(agent => agent.workflowId) ?? []).size
  const account = (tool: ComputerAccount['tool']) => accounts?.accounts.find(value => value.tool === tool)
  const preference = card.build?.preference
  return <article className="computer-card" aria-label={name}>
    <header className="computer-card-header">
      <Monitor size={20} aria-hidden="true" />
      <h3>{name}</h3>
      <Badge tone={online ? 'success' : 'neutral'} dot>{!observed ? 'Status unknown' : online ? 'Online' : 'Offline'}</Badge>
      {onOpen ? <IconButton label={`Open ${name}`} variant="ghost" size="sm" onClick={onOpen}><ChevronRight size={16} /></IconButton> : null}
    </header>
    <ComputerUtilization target={card.target} online={online} />
    <dl className="computer-card-facts">
      <div><dt>Harnesses</dt><dd className="computer-card-chips">
        {HARNESSES.map(({ tool, label }) => <HarnessChip key={tool} label={label} account={account(tool)} computer={name} known={Boolean(accounts)}
          version={maintenance?.harnesses.find(entry => entry.harness === tool)} busy={maintaining}
          onInstall={() => onMaintain({ kind: 'update-harnesses', harnesses: [tool] })} />)}
      </dd></div>
      <div><dt>GitHub</dt><dd><GitHubState account={account('github')} computer={name} known={Boolean(accounts)} /></dd></div>
      <div><dt>Builds</dt><dd>{card.buildError ? 'Unavailable' : !preference ? 'Loading…'
        : preference.buildEnabled ? `${ordinal(buildPosition)} of ${buildCount} · up to ${preference.buildAllowancePercent}% CPU and RAM` : 'Off'}
        {card.build?.state === 'setup-required' ? <Badge tone="warning">Setup needed</Badge> : null}</dd></div>
      <div><dt>Activity</dt><dd>{!observed ? '—' : `${count(observed.agents.length, 'agent')} running · ${count(workflows, 'workflow')}`
        + (observed.jobs.length ? ` · ${count(observed.jobs.length, 'job')}` : '')}</dd></div>
      {card.target.hostRef.kind === 'main' && card.build ? <div><dt>Worker execution</dt><dd>
        {card.build.remoteExecutionEnabled ? 'On' : 'Off'} <small className="computer-card-note">set when Main starts</small></dd></div> : null}
      <div><dt>System</dt><dd><SystemState status={maintenance} busy={maintaining} onMaintain={onMaintain} agents={observed?.agents.length ?? 0} /></dd></div>
      <div><dt>Disk</dt><dd>{maintenance?.system.disk ? `${bytes(maintenance.system.disk.freeBytes)} free of ${bytes(maintenance.system.disk.totalBytes)}` : '—'}</dd></div>
    </dl>
    {task ? <p className="computer-card-task" data-state={task.state} role="status">
      {task.state === 'running' ? `${taskLabel(task.kind)}…` : `${taskLabel(task.kind)}: ${task.summary}`}</p> : null}
    <footer className="computer-card-footer">
      <Button size="sm" variant="ghost" onClick={() => askOperator(`On ${name}: `, { send: false })}>Ask Operator to change…</Button>
    </footer>
  </article>
}

function HarnessChip({ label, account, computer, known, version, busy, onInstall }: {
  label: string; account: ComputerAccount | undefined; computer: string; known: boolean
  version: { installed: boolean; version: string | null; latest: string | null } | undefined; busy: boolean; onInstall(): void
}) {
  const installed = version ? version.installed : account?.installed
  if (!known && !version) return <Badge>{label} · unknown</Badge>
  if (!installed) return <span className="computer-card-chip">
    <Badge tone="warning">{label} · not installed</Badge>
    <Button size="sm" variant="ghost" disabled={busy} onClick={onInstall}>Install</Button>
  </span>
  const named = version?.version ? `${label} ${version.version}` : label
  if (version?.latest && version.version && version.latest !== version.version) return <span className="computer-card-chip">
    <Badge tone="warning">{named} · {version.latest} available</Badge>
    <Button size="sm" variant="ghost" disabled={busy} onClick={onInstall}>Update</Button>
  </span>
  if (account?.signedIn === false) return <span className="computer-card-chip">
    <Badge tone="warning">{named} · signed out</Badge>
    <Button size="sm" variant="ghost" onClick={() => askOperator(`Sign ${label} in on ${computer}.`)}>Sign in</Button>
  </span>
  return <Badge tone="success">{named}</Badge>
}

/** OS updates and restart. Restart asks once more because it stops what is running on that computer. */
function SystemState({ status, busy, onMaintain, agents }: { status: MaintenanceStatus | null | undefined; busy: boolean; onMaintain(task: Task): void; agents: number }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 6_000)
    return () => clearTimeout(timer)
  }, [confirming])
  if (!status) return <>—</>
  const updates = status.system.packageUpdates
  return <span className="computer-card-chip">
    {updates === null ? 'Updates unknown' : updates ? `${count(updates, 'pending update')}` : 'Up to date'}
    {updates ? <Button size="sm" variant="ghost" disabled={busy || !status.system.sudo} title={status.system.sudo ? undefined : 'Needs passwordless sudo'}
      onClick={() => onMaintain({ kind: 'update-system' })}>Update</Button> : null}
    {status.system.rebootRequired ? <Badge tone="warning">Restart needed</Badge> : null}
    <Button size="sm" variant={confirming ? 'danger' : 'ghost'} disabled={busy || !status.system.sudo}
      onClick={() => { if (confirming) { setConfirming(false); onMaintain({ kind: 'restart' }) } else setConfirming(true) }}>
      {confirming ? agents ? `Restart and stop ${count(agents, 'agent')}?` : 'Confirm restart' : 'Restart'}</Button>
  </span>
}

const TASK_LABELS: Record<string, string> = { 'update-harnesses': 'Harness update', 'update-system': 'System update', restart: 'Restart',
  'sync-mcp': 'MCP sync', 'sync-plugins': 'Plugin sync' }
function taskLabel(kind: string) { return TASK_LABELS[kind] ?? kind }
function bytes(value: number) { return value >= 1e12 ? `${(value / 1e12).toFixed(1)} TB` : `${Math.round(value / 1e9)} GB` }

function GitHubState({ account, computer, known }: { account: ComputerAccount | undefined; computer: string; known: boolean }) {
  if (!known) return <>—</>
  if (account?.installed && account.signedIn) return <>{account.account ?? 'Signed in'}</>
  return <span className="computer-card-chip">{account?.installed ? 'Signed out' : 'GitHub CLI not installed'}
    <Button size="sm" variant="ghost" onClick={() => askOperator(`Sign GitHub in on ${computer} and set up git to use it.`)}>Sign in</Button></span>
}

function ordinal(value: number) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? 'st' : value % 10 === 2 && value % 100 !== 12 ? 'nd' : value % 10 === 3 && value % 100 !== 13 ? 'rd' : 'th'
  return `${value}${suffix}`
}
function count(value: number, noun: string) { return `${value} ${noun}${value === 1 ? '' : 's'}` }
