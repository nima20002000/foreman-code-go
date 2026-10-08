import { ChevronRight, Monitor } from 'lucide-react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import type { ComputerAccount, ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import { computerDisplayName, type ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useBuildComputers } from '../../shared/api/buildComputers'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerAccounts } from '../../shared/api/computerAccounts'
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
  const fresh = useComputerActivityFreshness(activity.dataUpdatedAt, activity.fetchStatus)
  const cards: Card[] = targets.map((target, index) => ({ target, build: reads[index]!.data, buildError: reads[index]!.isError }))
    // The order builds use: enabled computers from the highest priority down.
    .sort((a, b) => Number(!a.build?.preference.buildEnabled) - Number(!b.build?.preference.buildEnabled)
      || (b.build?.preference.buildPriority ?? 0) - (a.build?.preference.buildPriority ?? 0)
      || computerKey(a.target).localeCompare(computerKey(b.target)))
  const builders = cards.filter(card => card.build?.preference.buildEnabled)
  return <>
    <ul className="computer-card-grid" aria-label="Computers">
      {cards.map(card => {
        const observed = activity.data?.mainId === mainId && !activity.isError
          ? activity.data.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target)) : undefined
        const entry = accounts.isError ? undefined : accounts.data?.computers.find(computer => sameDeviceProvisioningTarget(computer.target, card.target))
        return <li key={computerKey(card.target)}>
          <ComputerCard card={card} observed={observed} fresh={fresh} accounts={entry?.accounts}
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

function ComputerCard({ card, observed, fresh, accounts, buildPosition, buildCount, onOpen }: {
  card: Card; observed: ComputerActivity | undefined; fresh: boolean; accounts: ComputerAccounts | null | undefined
  buildPosition: number; buildCount: number; onOpen: (() => void) | undefined
}) {
  const name = observed?.name ?? computerDisplayName(card.target.hostRef)
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
        {HARNESSES.map(({ tool, label }) => <HarnessChip key={tool} label={label} account={account(tool)} computer={name} known={Boolean(accounts)} />)}
      </dd></div>
      <div><dt>GitHub</dt><dd><GitHubState account={account('github')} computer={name} known={Boolean(accounts)} /></dd></div>
      <div><dt>Builds</dt><dd>{card.buildError ? 'Unavailable' : !preference ? 'Loading…'
        : preference.buildEnabled ? `${ordinal(buildPosition)} of ${buildCount} · up to ${preference.buildAllowancePercent}% CPU and RAM` : 'Off'}
        {card.build?.state === 'setup-required' ? <Badge tone="warning">Setup needed</Badge> : null}</dd></div>
      <div><dt>Activity</dt><dd>{!observed ? '—' : `${count(observed.agents.length, 'agent')} running · ${count(workflows, 'workflow')}`
        + (observed.jobs.length ? ` · ${count(observed.jobs.length, 'job')}` : '')}</dd></div>
    </dl>
    <footer className="computer-card-footer">
      <Button size="sm" variant="ghost" onClick={() => askOperator(`On ${name}: `, { send: false })}>Ask Operator to change…</Button>
    </footer>
  </article>
}

function HarnessChip({ label, account, computer, known }: { label: string; account: ComputerAccount | undefined; computer: string; known: boolean }) {
  if (!known) return <Badge>{label} · unknown</Badge>
  if (!account?.installed) return <span className="computer-card-chip">
    <Badge tone="warning">{label} · not installed</Badge>
    <Button size="sm" variant="ghost" onClick={() => askOperator(`Install the latest ${label} on ${computer} and sign it in with the same account as Main.`)}>Install</Button>
  </span>
  if (account.signedIn === false) return <span className="computer-card-chip">
    <Badge tone="warning">{label} · signed out</Badge>
    <Button size="sm" variant="ghost" onClick={() => askOperator(`Sign ${label} in on ${computer}.`)}>Sign in</Button>
  </span>
  return <Badge tone="success">{label}</Badge>
}

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
