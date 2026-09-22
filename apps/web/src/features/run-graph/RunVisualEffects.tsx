import { useEffect, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGraphPresentationStore } from '../graph/useGraphPresentation'
import { graphRecordKey } from './cache'
import { useRunGraphContext } from './context'
import { createRunCuePolicy, type CueEnvironment } from './cuePolicy'
import type { RunGraphRecord } from './types'

/** Exactly one optional effect consumer per graph instance; never a fetcher or runtime owner. */
export function RunVisualEffects({ root }: { root: RefObject<HTMLElement | null> }) {
  const client = useQueryClient()
  const { scope, generation, subscribe } = useRunGraphContext()
  const presentation = useGraphPresentationStore()
  useEffect(() => {
    const policy = createRunCuePolicy()
    const key = graphRecordKey(scope, generation)
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const read = () => client.getQueryData<RunGraphRecord>(key)
    const environment = (): CueEnvironment => ({
      now: Date.now(), motion: Boolean(media && !media.matches && !document.hidden),
      focusedExchangeKey: presentation.getState().focusedExchangeKey,
      isVisible: (relationshipId) => {
        const canvas = root.current?.querySelector('.run-graph-canvas')
        // Quoted attribute escaping; do not interpolate an identifier as a selector or use document-global IDs.
        const escaped = relationshipId.replace(/["\\]/g, '\\$&')
        const edge = canvas?.querySelector(`[data-run-relationship="${escaped}"]`)
        if (!canvas || !edge) return false
        const bounds = canvas.getBoundingClientRect()
        const item = edge.getBoundingClientRect()
        return bounds.width > 0 && bounds.height > 0 && (item.width > 0 || item.height > 0)
          && item.right >= Math.max(0, bounds.left) && item.left <= Math.min(window.innerWidth, bounds.right)
          && item.bottom >= Math.max(0, bounds.top) && item.top <= Math.min(window.innerHeight, bounds.bottom)
      },
    })
    const publish = () => {
      if (disposed) return
      presentation.getState().setExchangeCues(policy.cues())
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const next = policy.nextWakeAt()
      if (next !== undefined) timer = setTimeout(() => { policy.tick(read(), environment()); publish() }, Math.max(0, next - Date.now()))
    }
    const observe = () => { policy.observe(read(), environment()); publish() }
    // Establish a silent baseline before accepting a live callback. Mounts never animate history.
    observe()
    const stopBatches = subscribe((signal) => { policy.accept(signal, read(), environment()); publish() })
    const stopCache = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.query.queryKey.length === key.length
        && event.query.queryKey.every((part: unknown, index: number) => part === key[index])) observe()
    })
    const stopPresentation = presentation.subscribe((next, before) => {
      if (next.epoch !== before.epoch) policy.clear()
      if (next.epoch !== before.epoch || next.focusedExchangeKey !== before.focusedExchangeKey) observe()
    })
    const visibility = () => {
      policy.clear()
      // Clear the baseline on either visibility transition as well as suppressing hidden callbacks.
      policy.observe(read(), { ...environment(), motion: false })
      publish()
    }
    document.addEventListener('visibilitychange', visibility)
    media?.addEventListener('change', visibility)
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      stopBatches(); stopCache(); stopPresentation()
      document.removeEventListener('visibilitychange', visibility)
      media?.removeEventListener('change', visibility)
      policy.clear()
      presentation.getState().setExchangeCues([])
    }
  }, [client, scope, generation, subscribe, presentation, root])
  return null
}
