import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useFloatingSurface } from './nocturne/useFloatingSurface'
import './sidebarHoverCard.css'

/** A sidebar icon's detail card: opens on hover or focus, stays while the pointer crosses to it, closes on Escape. */
export function useSidebarHoverCard() {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
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
  return {
    anchorProps: { ref: anchor, 'aria-describedby': open ? id : undefined,
      onMouseEnter: () => show(200), onMouseLeave: scheduleHide, onFocus: () => show(0), onBlur: scheduleHide },
    card: (content: ReactNode) => open && <div ref={surface} id={id} popover="manual" role="tooltip" className="n-theme sidebar-hover-card"
      onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={scheduleHide}>{content}</div>,
  }
}

export function SidebarHoverCardHeader({ icon, name, role }: { icon: ReactNode; name: string; role: string }) {
  return <header className="sidebar-hover-header"><span aria-hidden="true">{icon}</span><strong>{name}</strong><span>{role}</span></header>
}
