import { BaseEdge } from '@xyflow/react'
import type { EdgeSignal, FloatingCurve } from './signalEdge'

/** SignalEdge: base line, a mid chevron for direction, and light for a handoff, a result or a failure. */
export function SignalEdgeShape({ id, curve, kind = 'execution', signal, label, showLabel, reversed = false, interactionWidth = 24 }: {
  id: string; curve: FloatingCurve; kind?: 'execution' | 'approval'; signal?: EdgeSignal; label?: string; showLabel?: boolean
  reversed?: boolean; interactionWidth?: number
}) {
  const { mid } = curve
  return <g className="n-signal-edge" data-kind={kind} data-signal={signal}>
    <BaseEdge id={id} path={curve.path} className="n-signal-edge-base" interactionWidth={interactionWidth} />
    {signal ? <path className="n-signal-edge-trace" d={curve.path} /> : null}
    <path className="n-signal-edge-chevron" d="M -4 -4 L 2 0 L -4 4" transform={`translate(${mid.x} ${mid.y}) rotate(${mid.angle + (reversed ? 180 : 0)})`} />
    {signal ? <circle key={`${signal}:${reversed}`} className="n-signal-edge-pulse" data-reversed={reversed || undefined} r={4.5}
      style={{ offsetPath: `path('${curve.path}')` }} /> : null}
    {label && showLabel ? <g className="n-signal-edge-badge" transform={`translate(${mid.x} ${mid.y - 18})`}>
      <rect x={-(label.length * 3.6 + 12)} y={-11} width={label.length * 7.2 + 24} height={22} rx={11} />
      <text textAnchor="middle" y={4}>{label}</text>
    </g> : null}
  </g>
}
