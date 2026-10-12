import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import { useLayoutEffect, useRef } from 'react'
import { AgentHarnessSchema, type AgentHarness } from '@foreman-code/contracts'
import type { HostHarnessInstallationDto } from '@foreman-code/contracts/harness-registry'
import { harnessNames } from './settingsPresentation'
import { useHostHarnessRegistryQuery } from '../../shared/api/computerSettings'
import { useRuntimeIdentityQuery } from '../../shared/api/runtimeIdentity'
import { useNavigationUiStore } from '../workspaces/navigationUiStore'
import './harnessStatusMenu.css'

function installationStatus(installation: HostHarnessInstallationDto | undefined,
  read: { failed: boolean; pending: boolean }) {
  const { failed, pending } = read
  if (failed) {
    return { state: 'unverified', label: 'Unverified', detail: installation?.installed
      ? `Last inventory confirmed installation at ${installation.launcher.checkedAt}. Could not refresh installation status.`
      : 'Could not read installation status.' }
  }
  if (installation) {
    return { state: installation.installed ? 'installed' : 'missing',
      label: installation.installed ? 'Installed' : 'Not installed',
      detail: `Main computer inventory checked at ${installation.launcher.checkedAt}.` }
  }
  if (pending) return { state: 'checking', label: 'Checking', detail: 'Reading Main computer inventory.' }
  return { state: 'unverified', label: 'Unverified', detail: 'No installation inventory has been reported.' }
}

function HarnessStatus({ harness, installation, failed, pending }: {
  harness: AgentHarness; installation: HostHarnessInstallationDto | undefined; failed: boolean; pending: boolean
}) {
  const name = harnessNames[harness]
  const { state, label, detail } = installationStatus(installation, { failed, pending })
  const title = `${name}: ${label}. ${detail} Sign-in and profile qualification are checked separately before execution.`
  return <SidebarNavigationButton to="/settings/harnesses" search={{ harness, section: 'model' }} className="harness-status-link"
    aria-label={`${name}: ${label}`} title={title}>
    <span className={`harness-status-light harness-status-light--${state}`} aria-hidden="true" />
    <span className="harness-status-initial" aria-hidden="true">{harness === 'codex' ? 'CX' : 'CL'}</span>
    <span className="harness-status-name">{name}</span>
  </SidebarNavigationButton>
}

export function HarnessStatusMenu() {
  const menuRef = useRef<HTMLElement>(null)
  const previousPositions = useRef<DOMRect[]>([])
  const collapsed = useNavigationUiStore((state) => state.collapsed)
  const width = useNavigationUiStore((state) => state.width)
  const motion = useNavigationUiStore((state) => state.motion)
  const identity = useRuntimeIdentityQuery()
  const mainId = identity.data?.installationId
  const inventory = useHostHarnessRegistryQuery(mainId ? { kind: 'main', mainId } : undefined, mainId,
    { refetchInterval: 30_000 })
  const failed = identity.isError || identity.isPaused || inventory.isError || inventory.isPaused
  const pending = identity.isPending || inventory.isPending

  useLayoutEffect(() => {
    const links = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.harness-status-link') ?? [])
    const positions = links.map((link) => link.getBoundingClientRect())
    const animations: Animation[] = []
    if (motion === 'manual' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      links.forEach((link, index) => {
        const previous = previousPositions.current[index]
        const current = positions[index]
        if (!previous || !current || typeof link.animate !== 'function') return
        const x = previous.x - current.x
        const y = previous.y - current.y
        if (x === 0 && y === 0) return
        animations.push(link.animate([
          { transform: `translate(${x}px, ${y}px)`, opacity: 0.75 },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], { duration: 160, easing: 'cubic-bezier(0.22, 0, 0, 1)' }))
      })
    }
    previousPositions.current = positions
    return () => animations.forEach((animation) => animation.cancel())
  }, [collapsed, width, motion])

  return <nav ref={menuRef} className="harness-status-menu" aria-label="Harness availability">
    {AgentHarnessSchema.options.map((harness) => <HarnessStatus key={harness} harness={harness}
      installation={inventory.data?.installations.find(value => value.driverId === harness)}
      failed={failed} pending={pending} />)}
  </nav>
}
