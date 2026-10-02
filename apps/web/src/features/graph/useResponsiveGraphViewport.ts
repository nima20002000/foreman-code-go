import { useCallback, useEffect, useRef } from 'react'
import type { Edge, Node, ReactFlowInstance } from '@xyflow/react'

/** Fit options shared by both canvases. The low zoom floor keeps saved nodes reachable on phone widths. */
export const RESPONSIVE_MIN_ZOOM = 0.1
export const RESPONSIVE_FIT_OPTIONS = { padding: 0.2, minZoom: RESPONSIVE_MIN_ZOOM, maxZoom: 1 }

/**
 * Refits the viewport when the measured canvas size changes (e.g. desktop -> phone). Only the
 * viewport transform changes: node positions, draft/geometry/save callbacks and access are untouched.
 * Ordinary data rerenders never refit, and a user who has panned/zoomed keeps their view across
 * height-only changes (such as a mobile browser bar).
 */
export function useResponsiveGraphViewport<N extends Node = Node, E extends Edge = Edge>(
  { enabled = true, delay = 80 }: { enabled?: boolean; delay?: number } = {},
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const instance = useRef<ReactFlowInstance<N, E> | null>(null)
  const moved = useRef(false)
  const onInit = useCallback((next: ReactFlowInstance<N, E>) => { instance.current = next }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!enabled) { instance.current = null; return }
    if (!element || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: { w: number; h: number } | undefined
    const mark = () => { moved.current = true }
    element.addEventListener('pointerdown', mark, true)
    element.addEventListener('wheel', mark, { capture: true, passive: true })
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect
      if (!box) return
      const w = Math.round(box.width), h = Math.round(box.height)
      if (w <= 0 || h <= 0) return // hidden: nothing measurable to fit
      const prev = last
      last = { w, h }
      if (!prev || (prev.w === w && (prev.h === h || moved.current))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const flow = instance.current
        if (!flow || flow.getNodes().length === 0) return
        moved.current = false
        void flow.fitView({ ...RESPONSIVE_FIT_OPTIONS, duration: 0 })
      }, delay)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
      element.removeEventListener('pointerdown', mark, true)
      element.removeEventListener('wheel', mark, true)
    }
  }, [enabled, delay])

  return { containerRef, onInit }
}
