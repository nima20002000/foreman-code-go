import { forwardRef, useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import { IconButton } from './Button'
import { Tabs } from './Navigation'
import { cx } from './utils'

/** Visual state only. Feature code maps runtime facts to one of these; the canvas never infers progress. */
export type AgentNodeState = 'idle' | 'queued' | 'running' | 'waiting' | 'approved' | 'completed' | 'failed' | 'unavailable'
/** A one-shot cue: a pulse landing (arrive, and the colored ask/grant landings), ignition, completion, failure or a new wait. */
export type AgentNodeTransition = 'arrive' | 'ask' | 'grant' | 'ignite' | 'complete' | 'fail' | 'wait'
export type AgentPanel = 'chat' | 'settings' | 'info'

const actionLabels: Record<AgentPanel, string> = { chat: 'chat', settings: 'settings', info: 'information' }
const actionIcons: Record<AgentPanel, IconName> = { chat: 'chat', settings: 'settings', info: 'info' }

export interface AgentNodeViewProps {
  name: string
  /** Written out on the node; harness color is identity, never state. */
  harness?: string
  harnessLabel: string
  model?: string
  icon?: IconName
  statusLabel: string
  state?: AgentNodeState
  transition?: AgentNodeTransition
  /** Changes for every new cue, so the same cue twice in a row still plays twice. */
  transitionKey?: string | number
  /** Up to two short facts under the divider, such as effort and role. */
  meta?: readonly { label: string; value: string }[]
  entry?: boolean
  selected?: boolean
  openPanel?: AgentPanel
  /** Configuration edits waiting to be saved. */
  pending?: boolean
  ariaLabel?: string
  className?: string
  onSelect?: (event: MouseEvent<HTMLButtonElement>) => void
  onAction?: (panel: AgentPanel, event: MouseEvent<HTMLButtonElement>) => void
  /** Connection handles or other canvas adapters. */
  children?: ReactNode
}

/** The design-system AgentNode: a circle with harness rim, status word and rim actions (Chat, Settings, Info). */
export const AgentNodeView = forwardRef<HTMLButtonElement, AgentNodeViewProps>(function AgentNodeView({
  name, harness, harnessLabel, model, icon = 'bot', statusLabel, state = 'idle', transition, transitionKey, meta = [],
  entry, selected, openPanel, pending, ariaLabel, className, onSelect, onAction, children,
}, ref) {
  const known = harness === 'codex' || harness === 'opencode' ? harness : 'neutral'
  return <div className={cx('n-agent', className)} data-state={state} data-transition={transition} data-harness={known} data-selected={selected || undefined}
    data-open={openPanel ? '' : undefined} data-pending={pending || undefined} data-entry={entry || undefined}>
    <span className="n-agent-energy" aria-hidden="true" />
    {transition ? <span key={transitionKey ?? transition} className="n-agent-wave" aria-hidden="true">
      {transition === 'arrive' || transition === 'ask' || transition === 'grant' || transition === 'ignite'
        ? Array.from({ length: 10 }, (_, index) => <i key={index} style={{ '--spark': `${index * 36 + 8}deg` } as CSSProperties} />) : null}
    </span> : null}
    <button ref={ref} type="button" className="n-agent-core" aria-pressed={onSelect ? Boolean(selected) : undefined}
      aria-label={ariaLabel ?? `${name}, ${harnessLabel}${model ? `, ${model}` : ''}, ${statusLabel}`} onClick={onSelect}>
      <span key={statusLabel} className="n-agent-status"><i aria-hidden="true" />{statusLabel}</span>
      <span className="n-agent-glyph" aria-hidden="true"><Icon name={icon} size={20} /></span>
      <strong className="n-agent-name">{name}</strong>
      <span className="n-agent-harness">{harnessLabel}</span>
      {model ? <span className="n-agent-model" title={model}>{model}</span> : null}
      {meta.length ? <span className="n-agent-meta">{meta.slice(0, 2).map((item) => <span key={item.label}><small>{item.label}</small><b>{item.value}</b></span>)}</span> : null}
    </button>
    {state === 'completed' ? <span className="n-agent-done" aria-hidden="true"><Icon name="check" size={12} /></span> : null}
    {entry ? <span className="n-agent-entry">Starts here</span> : null}
    {onAction ? <div className="n-agent-actions" role="group" aria-label={`${name} actions`}>
      {(['chat', 'settings', 'info'] as const).map((panel) => <button key={panel} type="button"
        className={`n-agent-action n-agent-action--${panel} nodrag nopan`} aria-label={`Open ${name} ${actionLabels[panel]}`}
        title={panel === 'chat' ? 'Chat and activity' : panel === 'settings' ? 'Agent settings' : 'Status and details'}
        aria-expanded={openPanel === panel} onClick={(event) => { event.stopPropagation(); onAction(panel, event) }}>
        <Icon name={actionIcons[panel]} size={15} />
      </button>)}
    </div> : null}
    {children}
  </div>
})

export interface AgentPopoverProps {
  open: boolean
  /** The node element the panel sits beside. It follows the node while the canvas pans or zooms. */
  anchor: RefObject<HTMLElement | null>
  title: string
  subtitle?: string
  icon?: IconName
  harness?: string
  panel: AgentPanel
  onPanelChange: (panel: AgentPanel) => void
  onClose: () => void
  chat: ReactNode
  settings: ReactNode
  info: ReactNode
  className?: string
}

const GAP = 20
/** Nonmodal panel anchored beside an agent. Escape closes it; a phone gets a bottom sheet from CSS. */
export function AgentPopover({ open, anchor, title, subtitle, icon = 'bot', harness, panel, onPanelChange, onClose, chat, settings, info, className }: AgentPopoverProps) {
  const surface = useRef<HTMLElement>(null)
  const id = useId()
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0, last = ''
    const place = () => {
      const node = anchor.current, element = surface.current
      if (node && element && window.innerWidth > 720) {
        const rect = node.getBoundingClientRect()
        const width = element.offsetWidth, height = element.offsetHeight
        const right = rect.right + GAP + width <= window.innerWidth - 12
        const left = right ? rect.right + GAP : Math.max(12, rect.left - GAP - width)
        const top = Math.min(Math.max(12, rect.top + rect.height / 2 - 120), Math.max(12, window.innerHeight - height - 12))
        const key = `${Math.round(left)}:${Math.round(top)}`
        if (key !== last) { last = key; element.style.left = `${left}px`; element.style.top = `${top}px` }
      } else if (element && last !== 'sheet') { last = 'sheet'; element.style.left = ''; element.style.top = '' }
      frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [open, anchor])
  useEffect(() => {
    if (!open) return
    const owner = anchor.current?.closest('.n-agent')
    const active = document.activeElement
    // Focus returns to the rim action that opened the panel.
    const trigger = active instanceof HTMLElement && owner?.contains(active) ? active
      : owner?.querySelector<HTMLElement>('.n-agent-action[aria-expanded="true"]') ?? anchor.current
    const frame = requestAnimationFrame(() => {
      // Never pull focus away from something the person moved to meanwhile.
      const now = document.activeElement
      if (now && now !== document.body && now !== trigger && !owner?.contains(now)) return
      const panel = surface.current?.querySelector('[role=tabpanel]:not([hidden])')
      const field = panel?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]):not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      ;(field ?? surface.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]'))?.focus({ preventScroll: true })
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // An inner surface (menu, confirmation) closes first.
      if (document.querySelector('dialog[open]')) return
      event.preventDefault(); close.current()
    }
    const onPointer = (event: globalThis.MouseEvent) => {
      const target = event.target as Node | null
      if (!target || surface.current?.contains(target) || owner?.contains(target)) return
      if (target instanceof Element && target.closest('dialog[open], .n-menu, [role=listbox]')) return
      close.current()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer, true)
      const active = document.activeElement
      if (trigger?.isConnected && (!active || active === document.body || !active.isConnected)) trigger.focus({ preventScroll: true })
    }
  }, [open, anchor])
  if (!open || typeof document === 'undefined') return null
  const known = harness === 'codex' || harness === 'opencode' ? harness : 'neutral'
  return createPortal(<section ref={surface} className={cx('n-agent-popover nodrag nowheel', className)} data-harness={known}
    role="dialog" aria-modal="false" aria-label={`${title} ${actionLabels[panel]}`}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}>
    <header className="n-agent-popover-header">
      <span className="n-agent-popover-glyph" aria-hidden="true"><Icon name={icon} size={18} /></span>
      <div><h2 id={`${id}-title`}>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
      <IconButton label={`Close ${title}`} variant="ghost" onClick={onClose}><Icon name="close" size={16} /></IconButton>
    </header>
    <Tabs label={`${title} panels`} value={panel} onValueChange={(value) => onPanelChange(value as AgentPanel)} items={[
      { value: 'chat', label: 'Chat', content: <div className="n-agent-popover-body">{chat}</div> },
      { value: 'settings', label: 'Settings', content: <div className="n-agent-popover-body">{settings}</div> },
      { value: 'info', label: 'Info', content: <div className="n-agent-popover-body">{info}</div> },
    ]} />
  </section>, document.body)
}

/** Label and value rows for the Info panel. */
export function AgentFacts({ items }: { items: readonly { label: string; value: ReactNode; mono?: boolean }[] }) {
  return <dl className="n-agent-facts">{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd className={item.mono ? 'n-mono' : undefined}>{item.value}</dd></div>)}</dl>
}
