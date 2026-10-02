import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useLayoutEffect, useRef } from 'react'
import { AgentHarnessSchema, type AgentHarness } from '@graphql/contracts'
import { harnessNames } from './settingsPresentation'
import { getExecutionReadiness } from '../operator-chat/executionReadiness'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useNavigationUiStore } from '../workspaces/navigationUiStore'
import './harnessStatusMenu.css'

function HarnessStatus({ harness }: { harness: AgentHarness }) {
  const epoch = useHarnessSessionEpoch()
  const query = useQuery({
    queryKey: ['workbench', 'management', 'harness-readiness', epoch, harness],
    queryFn: ({ signal }) => getExecutionReadiness(harness, signal),
    enabled: !sessionIsSwitching(), retry: false, staleTime: 30_000, refetchInterval: 30_000,
  })
  const name = harnessNames[harness]
  const state = query.isError || query.isPaused ? 'unverified' : query.data?.status ?? 'checking'
  const label = state === 'eligible' ? 'Available' : state === 'blocked'
    ? query.data?.reason?.code === 'HARNESS_PROFILE_REQUIRED' ? 'Setup required'
      : query.data?.reason?.code === 'CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE' ? 'Not qualified' : 'Unavailable'
    : state === 'checking' ? 'Checking' : 'Unverified'
  const detail = query.isError ? 'Could not check harness availability.' : query.data?.reason?.message ?? 'Availability with saved harness settings. Workspace checks run when execution starts.'
  return <Link to="/settings/harnesses" search={{ harness, section: 'model' }} className="harness-status-link"
    aria-label={`${name}: ${label}`} title={`${name}: ${label}. ${detail}`}>
    <span className={`harness-status-light harness-status-light--${state}`} aria-hidden="true" />
    <span className="harness-status-initial" aria-hidden="true">{harness === 'codex' ? 'CX' : harness === 'opencode' ? 'OC' : 'CL'}</span>
    <span className="harness-status-name">{name}</span>
  </Link>
}

export function HarnessStatusMenu() {
  const menuRef = useRef<HTMLElement>(null)
  const previousPositions = useRef<DOMRect[]>([])
  const collapsed = useNavigationUiStore((state) => state.collapsed)
  const width = useNavigationUiStore((state) => state.width)
  const motion = useNavigationUiStore((state) => state.motion)

  useLayoutEffect(() => {
    const links = Array.from(menuRef.current?.querySelectorAll<HTMLAnchorElement>('.harness-status-link') ?? [])
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
    {AgentHarnessSchema.options.map((harness) => <HarnessStatus key={harness} harness={harness} />)}
  </nav>
}
