import type { ReadObservation } from '@foreman-code/contracts'
import { useEffect, useState } from 'react'
import { ChevronRight, Monitor } from 'lucide-react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import type { ComputerAccount, ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import { computerDisplayName, type ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useBuildComputers } from '../../shared/api/buildComputers'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useDeviceMcp } from '../../shared/api/deviceMcp'
import type { HarnessMcpList } from '@foreman-code/contracts/management'
import { useComputerAccounts } from '../../shared/api/computerAccounts'
import { useComputerMaintenance, useStartMaintenance } from '../../shared/api/computerMaintenance'
import type { ComputerMaintenanceStartInput, MaintenanceStatus, WorkerBundleReadiness, WorkerReleasePublication } from '@foreman-code/contracts/computer-maintenance'
import { Badge, Button, IconButton } from '../../shared/ui/nocturne'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { askOperator } from '../operator-chat/operatorChatStore'
import { MainRuntimeSetup } from '../runtime-qualification/MainRuntimeSetup'
import { ComputerUtilization } from './ComputerUtilization'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import './computerCards.css'

/** Harnesses this app runs: Codex and Claude. */
const HARNESSES = [{ tool: 'codex', label: 'Codex' }, { tool: 'claude', label: 'Claude' }] as const

type Card = { target: DeviceProvisioningTarget; build: BuildComputerStatus | undefined; buildError: boolean }

/** One summary card per computer. Changes go through the Operator agent; the cards update from readback. */
export function ComputerCards({ mainId, devices, onSelectComputer, only }: {
  mainId: string; devices: DeviceRegistration[]; onSelectComputer?: ((deviceId: string) => void) | undefined
  /** Show just this paired device (its details page). */
  only?: string
}) {
  const targets: DeviceProvisioningTarget[] = [{ hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null }, ...devices.filter(device => device.status === 'paired').map(device => ({
    hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId },
    applicationInstallationId: device.workerInstallationId, keyRevision: device.keyRevision,
    authorizationRevision: device.authorizationRevision,
  }))]
  const reads = useBuildComputers(targets)
  const visibleTargets = targets.filter(target => !only || target.hostRef.kind === 'device' && target.hostRef.deviceId === only)
  const activity = useComputerActivity()
  const accounts = useComputerAccounts(visibleTargets)
  const maintenance = useComputerMaintenance(visibleTargets)
  const mcp = useDeviceMcp(visibleTargets)
  const start = useStartMaintenance()
  const observedFresh = useComputerActivityFreshness(activity.dataUpdatedAt, activity.fetchStatus)
  const fresh = observedFresh && !activity.isError
  const cards: Card[] = targets.map((target, index) => ({ target, build: reads[index]!.data, buildError: reads[index]!.isError }))
    // The order builds use: enabled computers from the highest priority down.
    .sort((a, b) => Number(!a.build?.preference.buildEnabled) - Number(!b.build?.preference.buildEnabled)
      || (b.build?.preference.buildPriority ?? 0) - (a.build?.preference.buildPriority ?? 0)
      || computerKey(a.target).localeCompare(computerKey(b.target)))
  const builders = cards.filter(card => card.build?.preference.buildEnabled)
  const ranksKnown = reads.every(read => read.isSuccess)
  return <>
    <UnsavedEditorGuard editor={{ label: 'computer maintenance request', dirty: start.unresolved,
      busy: start.isPending, uncertain: start.unresolved, save: start.reconcile,
      discard: () => { if (!start.unresolved) start.reset() }, error: start.error?.message }} />
    {only ? null : <div className="computer-fleet-actions" role="group" aria-label="All computers">
      <Button size="sm" disabled={start.isPending || start.unresolved} onClick={() => {
        start.mutate([{ task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } },
          { task: { kind: 'update-system' } }])
      }}>Update computers</Button>
      <Button size="sm" variant="ghost" disabled={start.isPending || start.unresolved} onClick={() => {
        start.mutate([{ task: { kind: 'sync-mcp' } }, { task: { kind: 'sync-plugins' } }])
      }}>Sync MCP servers and plugins</Button>
    </div>}
    {start.unresolved ? <Button size="sm" disabled={start.isPending} onClick={start.retryOriginal}>
      {start.isPending ? 'Reconciling…' : 'Retry original maintenance request'}
    </Button> : null}
    {start.isError ? <small role="alert">{start.error.message}</small> : null}
    {start.data?.flatMap(result => result.computers).filter(computer => computer.error).map((computer, index) =>
      <small role="alert" key={`${computerKey(computer.target)}:${index}`}>
        {computerDisplayName(computer.target.hostRef)}: {computer.error}
      </small>)}
    <ul className="computer-card-grid" aria-label="Computers">
      {cards.filter(card => visibleTargets.includes(card.target)).map(card => {
        const index = visibleTargets.indexOf(card.target)
        const accountRead = accounts[index]!
        const maintenanceRead = maintenance[index]!
        const observed = activity.data?.mainId === mainId
          ? activity.data.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target)) : undefined
        return <li key={computerKey(card.target)}>
          <ComputerCard card={card} observed={observed} fresh={fresh}
            activityComplete={activity.data?.activityComplete === true && !activity.data.truncated}
            codexMcp={mcp[index * 2]?.isError ? undefined : mcp[index * 2]?.data}
            claudeMcp={mcp[index * 2 + 1]?.isError ? undefined : mcp[index * 2 + 1]?.data}
            accounts={accountRead.isError ? undefined : accountRead.data} maintenance={maintenanceRead.data?.status}
            workerPublication={maintenanceRead.data?.workerPublication}
            workerReadiness={maintenanceRead.data?.workerReadiness}
            maintenanceObservation={maintenanceRead.data?.observation}
            tasksOmitted={maintenanceRead.data?.tasksOmitted ?? 0}
            maintenanceError={maintenanceRead.isError || maintenanceRead.data?.observation?.status === 'unavailable'}
            onRetryMaintenance={() => { void maintenanceRead.refetch() }}
            onMaintain={task => start.mutate({ task, targets: [card.target] })} maintaining={start.isPending || start.unresolved}
            buildPosition={ranksKnown ? builders.indexOf(card) + 1 : undefined} buildCount={builders.length}
            onOpen={card.target.hostRef.kind === 'device' && onSelectComputer
              ? () => { if (card.target.hostRef.kind === 'device') onSelectComputer(card.target.hostRef.deviceId) } : undefined} />
        </li>
      })}
      {devices.filter(device => device.status !== 'paired' && (!only || device.deviceId === only)).map(device => <li key={device.deviceId}>
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
function ComputerCard({ card, observed, fresh, activityComplete, codexMcp, claudeMcp, accounts, maintenance, workerPublication, workerReadiness, maintenanceObservation, maintenanceError, tasksOmitted,
  onRetryMaintenance, onMaintain, maintaining, buildPosition, buildCount, onOpen }: {
  codexMcp: HarnessMcpList | undefined; claudeMcp: HarnessMcpList | undefined
  card: Card; observed: ComputerActivity | undefined; fresh: boolean; accounts: ComputerAccounts | null | undefined
  activityComplete: boolean; maintenanceError: boolean; onRetryMaintenance(): void
  maintenance: MaintenanceStatus | null | undefined; onMaintain(task: Task): void; maintaining: boolean
  workerPublication: WorkerReleasePublication | undefined
  workerReadiness: WorkerBundleReadiness | undefined
  maintenanceObservation: ReadObservation | undefined
  tasksOmitted: number
  buildPosition: number | undefined; buildCount: number; onOpen: (() => void) | undefined
}) {
  const name = observed?.name ?? computerDisplayName(card.target.hostRef)
  const tasks = maintenance?.tasks ?? []
  const online = fresh && observed?.online === true
  const workflows = new Set(observed?.agents.map(agent => agent.workflowId) ?? []).size
  const account = (tool: ComputerAccount['tool']) => accounts?.accounts.find(value => value.tool === tool)
  return <article className="computer-card" aria-label={name}>
    <header className="computer-card-header">
      <Monitor size={20} aria-hidden="true" />
      <h3>{name}</h3>
      <Badge tone={online ? 'success' : 'neutral'} dot>{presenceLabel(observed, fresh)}</Badge>
      {onOpen ? <IconButton label={`Open ${name}`} variant="ghost" size="sm" onClick={onOpen}><ChevronRight size={16} /></IconButton> : null}
    </header>
    <ComputerUtilization target={card.target} online={online} />
    <dl className="computer-card-facts">
      <div><dt>Harnesses</dt><dd className="computer-card-chips">
        {HARNESSES.map(({ tool, label }) => <HarnessChip key={tool} label={label} account={account(tool)} computer={name} known={Boolean(accounts)}
          version={maintenance?.harnesses.find(entry => entry.harness === tool)} busy={maintaining || maintenanceError}
          onInstall={() => onMaintain({ kind: 'update-harnesses', harnesses: [tool] })} />)}
      </dd></div>
      {card.target.hostRef.kind === 'device' ? <div><dt>Worker</dt><dd>
        <WorkerState worker={maintenance?.worker} readiness={workerReadiness} busy={maintaining || maintenanceError
          || Boolean(workerPublication && workerPublication.state !== 'published')}
          onUpdate={() => onMaintain({ kind: 'update-worker' })} />
      </dd></div> : null}
      {workerPublication && workerPublication.state !== 'published' ? <div><dt>Worker release</dt><dd>
        <p role={workerPublication.state === 'failed' ? 'alert' : 'status'}>
          Worker {workerPublication.version} {workerPublication.state === 'failed'
            ? 'publication failed' : 'is waiting for GitHub publication and verification'}.
          {workerPublication.lastError ? <small>{workerPublication.lastError}</small> : null}
        </p>
      </dd></div> : null}
      {card.target.hostRef.kind === 'device' ? <div><dt>Foreman Code MCP</dt><dd>
        <span>Codex · {mcpState(codexMcp?.presets?.graphql)}</span>{' · '}
        <span>Claude · {mcpState(claudeMcp?.presets?.graphql)}</span>
      </dd></div> : null}
      <div><dt>GitHub</dt><dd><GitHubState account={account('github')} computer={name} known={Boolean(accounts)} /></dd></div>
      <div><dt>Builds</dt><dd>{buildSummary(card, buildPosition, buildCount)}
        {card.build?.state === 'setup-required' ? <Badge tone="warning">Setup needed</Badge> : null}</dd></div>
      <div><dt>Activity</dt><dd>{observed ? <>
        {!fresh ? 'Last observed: ' : null}{!activityComplete ? 'Visible activity: ' : null}
        {`${count(observed.agents.length, 'agent')} running · ${count(workflows, 'workflow')}`}
        {observed.jobs.length ? ` · ${count(observed.jobs.length, 'job')}` : ''}
        {!activityComplete ? <small>Other activity may not be visible.</small> : null}
      </> : 'Activity unknown'}</dd></div>
      {card.target.hostRef.kind === 'main' && card.build ? <div><dt>Worker execution</dt><dd>
        {card.build.remoteExecutionEnabled ? 'On' : 'Off'} <small className="computer-card-note">set when Main starts</small></dd></div> : null}
      <div><dt>System</dt><dd><SystemState status={maintenance} busy={maintaining || maintenanceError}
        onMaintain={onMaintain} agents={observed?.agents.length ?? 0} jobs={observed?.jobs.length ?? 0}
        activityComplete={Boolean(observed) && fresh && activityComplete} /></dd></div>
      <div><dt>Disk</dt><dd>{maintenance?.system.disk ? `${bytes(maintenance.system.disk.freeBytes)} free of ${bytes(maintenance.system.disk.totalBytes)}` : '—'}</dd></div>
    </dl>
    {maintenanceError ? <div role="alert" className="computer-card-note">
      <p>Maintenance could not be refreshed.{maintenance ? <> Showing last confirmed details from <time dateTime={maintenance.observedAt}>{maintenance.observedAt}</time>. Current task state is unknown.</> : null}</p>
      {maintenanceObservation?.status === 'unavailable' ? <p>
        {maintenanceObservation.lastError} {maintenanceObservation.consecutiveFailures} consecutive failed reads.
        {maintenanceObservation.lastSuccess ? <> Last successful read: <time dateTime={maintenanceObservation.lastSuccess}>
          {maintenanceObservation.lastSuccess}</time>.</> : null}
      </p> : null}
      <Button size="sm" variant="ghost" onClick={onRetryMaintenance}>Retry maintenance</Button>
    </div> : null}
    {tasks.map(task => <p key={task.id} className="computer-card-task" data-state={task.state} role="status">
      {maintenanceError ? 'Last confirmed: ' : null}
      {task.state === 'running' ? `${taskLabel(task.kind)}…` : `${taskLabel(task.kind)}: ${task.summary}`}</p>)}
    {tasksOmitted > 0 ? <p className="computer-card-note">{count(tasksOmitted, 'older maintenance task')} not shown.</p> : null}
    <footer className="computer-card-footer">
      <Button size="sm" variant="ghost" onClick={() => askOperator(`On ${name}: `, { send: false })}>Ask Operator to change…</Button>
    </footer>
  </article>
}

function mcpState(state: NonNullable<HarnessMcpList['presets']>['graphql'] | undefined) {
  if (state === 'installed') return 'Installed'
  if (state === 'disabled') return 'Disabled'
  if (state === 'missing') return 'Setup needed'
  if (state) return 'Needs repair'
  return 'State unavailable'
}

function HarnessChip({ label, account, computer, known, version, busy, onInstall }: {
  label: string; account: ComputerAccount | undefined; computer: string; known: boolean
  version: { installed: boolean; version: string | null; latest: string | null } | undefined; busy: boolean; onInstall(): void
}) {
  const installed = version ? version.installed : account?.installed
  if ((!known && !version) || installed === undefined) return <Badge>{label} · account unknown</Badge>
  if (!installed) return <span className="computer-card-chip">
    <Badge tone="warning">{label} · not installed</Badge>
    <Button size="sm" variant="ghost" disabled={busy} onClick={onInstall}>Install</Button>
  </span>
  const named = version?.version ? `${label} ${version.version}` : label
  const summary = account?.signedIn == null ? `${named} · account unknown` : named
  if (version?.latest && version.version && version.latest !== version.version) return <span className="computer-card-chip">
    <Badge tone="warning">{summary} · {version.latest} available</Badge>
    <Button size="sm" variant="ghost" disabled={busy} onClick={onInstall}>Update</Button>
  </span>
  if (account?.signedIn === false) return <span className="computer-card-chip">
    <Badge tone="warning">{named} · signed out</Badge>
    <Button size="sm" variant="ghost" onClick={() => askOperator(`Sign ${label} in on ${computer}.`)}>Sign in</Button>
  </span>
  if (account?.signedIn == null) return <Badge>{summary}</Badge>
  return <Badge tone="success">{named}</Badge>
}

type WorkerStatus = NonNullable<MaintenanceStatus['worker']>
const WORKER_STATE_LABELS: Record<WorkerStatus['state'], string> = {
  current: 'Up to date',
  pending: 'Update pending',
  draining: 'Waiting for current work to finish',
  downloading: 'Downloading update',
  installing: 'Installing update',
  restarting: 'Restarting Worker',
  'rolled-back': 'Rolled back to previous version',
  failed: 'Update failed',
}

function WorkerState({ worker, readiness, busy, onUpdate }: {
  worker: MaintenanceStatus['worker']; readiness: WorkerBundleReadiness | undefined; busy: boolean; onUpdate(): void
}) {
  const retry = worker?.state === 'failed' || worker?.state === 'rolled-back'
  const updating = worker !== undefined && worker.state !== 'current' && !retry
  let label = worker ? WORKER_STATE_LABELS[worker.state] : 'Status unavailable'
  if (worker?.state === 'current' && readiness?.ready === false) {
    if (readiness.code === 'WORKER_VERSION_SKEW') label = 'Worker update required'
    if (readiness.code === 'WORKER_BUNDLE_UNPUBLISHED') label = 'Worker bundle unavailable'
    if (readiness.code === 'WORKER_UPDATING') label = 'Worker update in progress'
  }
  return <span className="computer-card-worker">
    {worker ? <>
      <span>Current {worker.currentVersion}</span>
      <span>Target {worker.targetVersion ?? 'not reported'}</span>
      <span role="status"><Badge tone={retry || readiness?.ready === false ? 'warning' : 'neutral'}>{label}</Badge></span>
      {worker.lastError ? <small className="computer-card-worker-error">Last error: {worker.lastError}</small> : null}
    </> : <span>Status unavailable</span>}
    <Button size="sm" variant="ghost" disabled={busy || !worker || updating} onClick={onUpdate}>
      {retry ? 'Retry Worker update' : 'Update Worker'}
    </Button>
  </span>
}

/** OS updates and restart. Restart asks once more because it stops what is running on that computer. */
function SystemState({ status, busy, onMaintain, agents, jobs, activityComplete }: {
  status: MaintenanceStatus | null | undefined; busy: boolean; onMaintain(task: Task): void
  agents: number; jobs: number; activityComplete: boolean
}) {
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
      {confirming ? restartConfirmation(agents, jobs, activityComplete) : 'Restart'}</Button>
  </span>
}

function presenceLabel(observed: ComputerActivity | undefined, fresh: boolean) {
  if (!observed) return 'Status unknown'
  if (!fresh) return 'Status stale'
  return observed.online ? 'Online' : 'Offline'
}

function buildSummary(card: Card, position: number | undefined, total: number) {
  if (card.buildError) return 'Unavailable'
  const preference = card.build?.preference
  if (!preference) return 'Loading…'
  if (!preference.buildEnabled) return 'Off'
  const rank = position === undefined ? 'Fleet priority loading' : `${ordinal(position)} of ${total}`
  return `${rank} · up to ${preference.buildAllowancePercent}% CPU and RAM`
}

function restartConfirmation(agents: number, jobs: number, complete: boolean) {
  const work = [agents ? count(agents, 'agent') : '', jobs ? count(jobs, 'job') : ''].filter(Boolean).join(' and ')
  if (!complete) return work ? `Restart and stop ${work}? Other work may be running` : 'Restart? Other work may be running'
  return work ? `Restart and stop ${work}?` : 'Confirm restart'
}

const TASK_LABELS: Record<string, string> = { 'update-harnesses': 'Harness update', 'update-system': 'System update', restart: 'Restart',
  'sync-mcp': 'MCP sync', 'sync-plugins': 'Plugin sync', 'update-worker': 'Worker update' }
function taskLabel(kind: string) { return TASK_LABELS[kind] ?? kind }
function bytes(value: number) { return value >= 1e12 ? `${(value / 1e12).toFixed(1)} TB` : `${Math.round(value / 1e9)} GB` }

function GitHubState({ account, computer, known }: { account: ComputerAccount | undefined; computer: string; known: boolean }) {
  if (!known || !account) return <>Account unknown</>
  if (!account.installed) return <>GitHub CLI not installed</>
  if (account.signedIn === null) return <>Account unknown</>
  if (account.signedIn === true) return <>{account.account ?? 'Signed in'}</>
  return <span className="computer-card-chip">Signed out
    <Button size="sm" variant="ghost" onClick={() => askOperator(`Sign GitHub in on ${computer} and set up git to use it.`)}>Sign in</Button></span>
}

function ordinal(value: number) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? 'st' : value % 10 === 2 && value % 100 !== 12 ? 'nd' : value % 10 === 3 && value % 100 !== 13 ? 'rd' : 'th'
  return `${value}${suffix}`
}
function count(value: number, noun: string) { return `${value} ${noun}${value === 1 ? '' : 's'}` }
