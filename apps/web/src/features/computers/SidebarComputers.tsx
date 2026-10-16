import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import { Cloud, Laptop, Monitor } from 'lucide-react'
import type { CloudCiActivity, ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerMaintenance } from '../../shared/api/computerMaintenance'
import { useHostHarnessRegistryQuery } from '../../shared/api/computerSettings'
import { SidebarHoverCardHeader as CardHeader } from '../../shared/ui/SidebarHoverCardHeader'
import { useSidebarHoverCard } from '../../shared/ui/useSidebarHoverCard'
import { presentationFor } from '../settings/computerPresenceModel'
import { ComputerUtilization } from './ComputerUtilization'
import { computerLoad, LOAD_LABELS, type ComputerLoadLevel } from './computerLoad'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import { useComputerReadings } from './useComputerReadings'
import './computers.css'

/** Every paired computer and cloud CI service as one icon-only button colored by load; hover or focus shows its details. */
export function SidebarComputers() {
  const query = useComputerActivity()
  // A failed refresh keeps the last list; without a fresh observation nothing is presented as current.
  const fresh = useComputerActivityFreshness(query.dataUpdatedAt, query.fetchStatus) && !query.isError
  const computers = query.data?.computers ?? []
  const clouds = query.data?.cloud ?? []
  if (computers.length + clouds.length === 0) return null
  const complete = query.data?.activityComplete === true && !query.data.truncated
  return <ul className="sidebar-computers" aria-label="Computers">
    {computers.map(computer => <ComputerRow key={computerKey(computer.target)} computer={computer} fresh={fresh} complete={complete} />)}
    {clouds.map(cloud => <CloudRow key={`${cloud.provider}@${cloud.account ?? ''}`} cloud={cloud} fresh={fresh} />)}
  </ul>
}

function ComputerRow({ computer, fresh, complete }: { computer: ComputerActivity; fresh: boolean; complete: boolean }) {
  const online = fresh && computer.online
  const readings = useComputerReadings(computer.target, online)
  const workloads = computer.agents.length + computer.jobs.length
  const activityIds = useMemo(() => [
    ...computer.agents.map(agent => `agent:${agent.id}`),
    ...computer.jobs.map(job => `job:${job.id}`),
  ], [computer.agents, computer.jobs])
  const level = computerLoad({ online: fresh ? computer.online : null, cpuPercent: readings.cpu, memoryPercent: readings.memory,
    diskUsedPercent: readings.storageUsedPercent, workloads })
  const main = computer.target.hostRef.kind === 'main'
  const hostRef = computer.target.hostRef
  return <HoverRow level={level} label={`${computer.name}, ${main ? 'Main' : 'Worker'}, ${LOAD_LABELS[level]}`}
    runningCount={online ? workloads : 0} activityIds={activityIds}
    icon={main ? <Monitor size={16} /> : <Laptop size={16} />}
    link={hostRef.kind === 'device' ? { to: '/settings/computers/$deviceId', params: { deviceId: hostRef.deviceId } } : { to: '/settings/computers' }}
    card={<ComputerDetails computer={computer} online={online} fresh={fresh} complete={complete} level={level} />} />
}

function CloudRow({ cloud, fresh }: { cloud: CloudCiActivity; fresh: boolean }) {
  const level = computerLoad({ online: fresh ? cloud.ready : null, cpuPercent: null, memoryPercent: null, diskUsedPercent: null,
    ciSlotsPercent: cloud.running / cloud.slots * 100, workloads: 0 })
  const state = !fresh ? LOAD_LABELS.unknown : !cloud.ready ? 'Not logged in on Main' : `${cloud.running} of ${cloud.slots} CI machines in use`
  return <HoverRow level={level} label={`${cloud.name}, Cloud CI, ${!fresh || cloud.ready ? LOAD_LABELS[level] : state}`}
    runningCount={fresh && cloud.ready ? cloud.running : 0}
    icon={<Cloud size={16} />}
    link={{ to: '/settings/computers' }}
    card={<div className="sidebar-hover-body">
      <CardHeader icon={<Cloud size={16} />} name={cloud.name} role="Cloud CI" />
      <p className="sidebar-hover-state" data-load={level}>{state}</p>
    </div>} />
}

type RowLink = { to: '/settings/computers' } | { to: '/settings/computers/$deviceId'; params: { deviceId: string } }

function HoverRow({ level, label, icon, link, card, runningCount, activityIds }: {
  level: ComputerLoadLevel; label: string; icon: ReactNode; link: RowLink; card: ReactNode
  runningCount: number; activityIds?: string[]
}) {
  const hover = useSidebarHoverCard()
  const countLabel = `${runningCount} running ${runningCount === 1 ? 'Agent or CI job' : 'Agents and CI jobs'}`
  return <li data-load={level}>
    <SidebarNavigationButton {...hover.anchorProps} {...link} className="sidebar-computer"
      aria-label={runningCount > 0 ? `${label}, ${countLabel}` : label}>
      <ComputerIcon icon={icon} runningCount={runningCount} activityIds={activityIds} />
    </SidebarNavigationButton>
    {hover.card(card)}
  </li>
}

function ComputerIcon({ icon, runningCount, activityIds }: {
  icon: ReactNode; runningCount: number; activityIds: string[] | undefined
}) {
  const glyph = useRef<HTMLSpanElement>(null)
  const previous = useRef({ runningCount, activityIds })
  useEffect(() => {
    const started = activityIds
      ? activityIds.some(id => !previous.current.activityIds?.includes(id))
      : runningCount > previous.current.runningCount
    previous.current = { runningCount, activityIds }
    if (!started || runningCount === 0) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (motion.matches) return
    const animation = glyph.current?.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' },
    ], { duration: 300, easing: 'ease-out' })
    function stopMotion() { if (motion.matches) animation?.cancel() }
    motion.addEventListener('change', stopMotion)
    return () => {
      animation?.cancel()
      motion.removeEventListener('change', stopMotion)
    }
  }, [activityIds, runningCount])
  return <span className="sidebar-computer-icon" data-running={runningCount > 0 ? '' : undefined} aria-hidden="true">
    <span ref={glyph} className="sidebar-computer-glyph">{icon}</span>
    {runningCount > 0 && <span className="sidebar-computer-count">{runningCount > 9 ? '9+' : runningCount}</span>}
  </span>
}

const SHOWN_ITEMS = 3

function ago(at: number) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  return seconds < 60 ? `${seconds} s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago`
    : seconds < 86_400 ? `${Math.floor(seconds / 3600)} h ago` : `${Math.floor(seconds / 86_400)} d ago`
}

/** Mounted only while the card is open, so versions and last-seen are read on demand. */
function ComputerDetails({ computer, online, fresh, complete, level }: {
  computer: ComputerActivity; online: boolean; fresh: boolean; complete: boolean; level: ComputerLoadLevel
}) {
  const target = computer.target
  const device = target.hostRef.kind === 'device'
  const maintenance = useComputerMaintenance([target])[0]?.data?.status
  const registry = useHostHarnessRegistryQuery(device ? target.hostRef : undefined, target.applicationInstallationId)
  const presence = device ? presentationFor(target.hostRef, target.applicationInstallationId, registry.data?.hostMetadata) : undefined
  const connection = presence?.kind === 'observed' ? presence.connection : undefined
  const appVersion = maintenance?.worker?.currentVersion ?? connection?.appVersion
  const harness = (tool: 'codex' | 'claude') => {
    const entry = maintenance?.harnesses.find(value => value.harness === tool)
    return entry ? entry.installed ? entry.version ?? 'Installed' : 'Not installed' : undefined
  }
  const versions = [['App', appVersion], ['Codex', harness('codex')], ['Claude', harness('claude')]] as const
  const state = !fresh ? LOAD_LABELS.unknown : online ? `Online · ${LOAD_LABELS[level]}` : 'Offline'
  return <div className="sidebar-hover-body">
    <CardHeader icon={device ? <Laptop size={16} /> : <Monitor size={16} />} name={computer.name} role={device ? 'Worker' : 'Main'} />
    <p className="sidebar-hover-state" data-load={level}>{state}
      {connection && <span> · last seen {ago(Date.parse(connection.lastSeenAt))}</span>}</p>
    {online && <ComputerUtilization target={target} online />}
    <ActivityList label="Agents" items={computer.agents.map(agent => `${agent.agentName} · ${agent.workflowName}`)} />
    <ActivityList label="CI jobs" items={computer.jobs.map(job => `${job.name} · ${job.workspaceName}`)} />
    {!complete && <p className="sidebar-hover-note">Showing activity you can read.</p>}
    {versions.some(([, value]) => value) && <dl className="computer-hover-versions">
      {versions.filter(([, value]) => value).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>}
  </div>
}

function ActivityList({ label, items }: { label: string; items: string[] }) {
  return <section className="computer-hover-activity" aria-label={label}>
    <h4>{label} <span>{items.length ? items.length : 'None running'}</span></h4>
    {items.length > 0 && <ul>
      {items.slice(0, SHOWN_ITEMS).map((item, index) => <li key={index}>{item}</li>)}
      {items.length > SHOWN_ITEMS && <li>and {items.length - SHOWN_ITEMS} more</li>}
    </ul>}
  </section>
}
