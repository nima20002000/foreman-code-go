import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Cloud, Laptop, Monitor } from 'lucide-react'
import type { CloudCiActivity, ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { useComputerMaintenance } from '../../shared/api/computerMaintenance'
import { useHostHarnessRegistryQuery } from '../../shared/api/computerSettings'
import { useFloatingSurface } from '../../shared/ui/nocturne/useFloatingSurface'
import { presentationFor } from '../settings/computerPresenceModel'
import { ComputerUtilization } from './ComputerUtilization'
import { computerLoad, LOAD_LABELS, type ComputerLoadLevel } from './computerLoad'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import { useComputerReadings } from './useComputerReadings'
import './computers.css'

/** Every paired computer and cloud CI service as one icon colored by load; hover or focus shows its details. */
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
    {clouds.map(cloud => <CloudRow key={cloud.provider} cloud={cloud} fresh={fresh} />)}
  </ul>
}

function ComputerRow({ computer, fresh, complete }: { computer: ComputerActivity; fresh: boolean; complete: boolean }) {
  const online = fresh && computer.online
  const readings = useComputerReadings(computer.target, online)
  const workloads = computer.agents.length + computer.jobs.length
  const level = computerLoad({ online: fresh ? computer.online : null, cpuPercent: readings.cpu, memoryPercent: readings.memory,
    diskUsedPercent: readings.storageUsedPercent, workloads })
  const main = computer.target.hostRef.kind === 'main'
  const metric = level === 'offline' ? 'Offline' : !online ? '—'
    : readings.cpu !== null || readings.memory !== null
      ? (readings.memory ?? -1) > (readings.cpu ?? -1) ? `RAM ${Math.round(readings.memory!)}%` : `CPU ${Math.round(readings.cpu!)}%`
      : workloads ? `${workloads} running` : '—'
  const hostRef = computer.target.hostRef
  return <HoverRow level={level} label={`${computer.name}, ${main ? 'Main' : 'Worker'}, ${LOAD_LABELS[level]}`}
    icon={main ? <Monitor size={16} /> : <Laptop size={16} />} name={computer.name} metric={metric}
    link={hostRef.kind === 'device' ? { to: '/settings/computers/$deviceId', params: { deviceId: hostRef.deviceId } } : { to: '/settings/computers' }}
    card={<ComputerDetails computer={computer} online={online} fresh={fresh} complete={complete} level={level} />} />
}

function CloudRow({ cloud, fresh }: { cloud: CloudCiActivity; fresh: boolean }) {
  const level = computerLoad({ online: fresh ? cloud.ready : null, cpuPercent: null, memoryPercent: null, diskUsedPercent: null,
    ciSlotsPercent: cloud.running / cloud.slots * 100, workloads: 0 })
  const state = !fresh ? LOAD_LABELS.unknown : !cloud.ready ? 'Not logged in on Main' : `${cloud.running} of ${cloud.slots} CI machines in use`
  return <HoverRow level={level} label={`${cloud.name}, Cloud CI, ${!fresh || cloud.ready ? LOAD_LABELS[level] : state}`}
    icon={<Cloud size={16} />} name={cloud.name} metric={fresh && cloud.ready ? `${cloud.running}/${cloud.slots}` : '—'}
    link={{ to: '/settings/computers' }}
    card={<div className="computer-hover-body">
      <CardHeader icon={<Cloud size={16} />} name={cloud.name} role="Cloud CI" />
      <p className="computer-hover-state" data-load={level}>{state}</p>
    </div>} />
}

type RowLink = { to: '/settings/computers' } | { to: '/settings/computers/$deviceId'; params: { deviceId: string } }

function HoverRow({ level, label, icon, name, metric, link, card }: {
  level: ComputerLoadLevel; label: string; icon: ReactNode; name: string; metric: string; link: RowLink; card: ReactNode
}) {
  const id = useId()
  const anchor = useRef<HTMLAnchorElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [open, setOpen] = useState(false)
  useFloatingSurface(open, anchor, surface, 288, 'start', 'inline')
  function show(delay: number) { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), delay) }
  function scheduleHide() {
    clearTimeout(timer.current)
    // The gap to the card stays traversable; the card must not vanish under the pointer.
    timer.current = setTimeout(() => {
      if (!anchor.current?.matches(':hover') && !surface.current?.matches(':hover') && document.activeElement !== anchor.current) setOpen(false)
    }, 160)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { clearTimeout(timer.current); setOpen(false) } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open])
  return <li data-load={level}>
    <Link ref={anchor} {...link} className="sidebar-computer" aria-label={label} aria-describedby={open ? id : undefined}
      onMouseEnter={() => show(200)} onMouseLeave={scheduleHide} onFocus={() => show(0)} onBlur={scheduleHide}>
      <span className="sidebar-computer-icon" aria-hidden="true">{icon}</span>
      <span className="sidebar-computer-name" aria-hidden="true">{name}</span>
      <span className="sidebar-computer-metric" aria-hidden="true">{metric}</span>
    </Link>
    {open && <div ref={surface} id={id} popover="manual" role="tooltip" className="n-theme computer-hover-card"
      onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={scheduleHide}>{card}</div>}
  </li>
}

function CardHeader({ icon, name, role }: { icon: ReactNode; name: string; role: string }) {
  return <header className="computer-hover-header"><span aria-hidden="true">{icon}</span><strong>{name}</strong><span>{role}</span></header>
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
  return <div className="computer-hover-body">
    <CardHeader icon={device ? <Laptop size={16} /> : <Monitor size={16} />} name={computer.name} role={device ? 'Worker' : 'Main'} />
    <p className="computer-hover-state" data-load={level}>{state}
      {connection && <span> · last seen {ago(Date.parse(connection.lastSeenAt))}</span>}</p>
    {online && <ComputerUtilization target={target} online />}
    <ActivityList label="Agents" items={computer.agents.map(agent => `${agent.agentName} · ${agent.workflowName}`)} />
    <ActivityList label="CI jobs" items={computer.jobs.map(job => `${job.name} · ${job.workspaceName}`)} />
    {!complete && <p className="computer-hover-note">Showing activity you can read.</p>}
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
