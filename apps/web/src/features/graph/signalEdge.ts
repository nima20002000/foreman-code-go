import { useInternalNode, type InternalNode, type Node } from '@xyflow/react'
import type { Agent } from '@graphql/contracts'
import type { IconName } from '../../shared/ui/nocturne'

/** Rendered agent diameter (canvas.css `--agent-size`). Saved card sizes are ignored on the canvas. */
export const AGENT_NODE_SIZE = 212
const RIM_GAP = 7

type Point = { x: number; y: number }
export type EdgeSignal = 'task' | 'return' | 'error'
export type FloatingCurve = { path: string; mid: Point & { angle: number } }

function center(node: InternalNode<Node>): Point {
  const width = node.measured.width ?? AGENT_NODE_SIZE, height = node.measured.height ?? AGENT_NODE_SIZE
  return { x: node.internals.positionAbsolute.x + width / 2, y: node.internals.positionAbsolute.y + height / 2 }
}
const unit = (x: number, y: number) => { const length = Math.hypot(x, y) || 1; return { x: x / length, y: y / length } }

/** A gently bent curve that leaves and enters each agent anywhere on its rim. */
export function floatingCurve(source: Point, target: Point, bend: number, radius = AGENT_NODE_SIZE / 2 + RIM_GAP): FloatingCurve {
  const dx = target.x - source.x, dy = target.y - source.y, length = Math.hypot(dx, dy) || 1
  const control = { x: (source.x + target.x) / 2 - dy / length * bend, y: (source.y + target.y) / 2 + dx / length * bend }
  const leave = unit(control.x - source.x, control.y - source.y), enter = unit(target.x - control.x, target.y - control.y)
  const start = { x: source.x + leave.x * radius, y: source.y + leave.y * radius }
  const end = { x: target.x - enter.x * radius, y: target.y - enter.y * radius }
  const mid = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 }
  const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI
  const round = (value: number) => Math.round(value * 10) / 10
  return { path: `M ${round(start.x)},${round(start.y)} Q ${round(control.x)},${round(control.y)} ${round(end.x)},${round(end.y)}`, mid: { ...mid, angle } }
}

/** Parallel connections between the same pair fan out instead of overlapping. */
export function edgeBend(index: number, forward: boolean) {
  const step = Math.ceil(index / 2) * (index % 2 ? 1 : -1)
  return (28 + step * 44) * (forward ? 1 : -1)
}

export function useFloatingCurve(source: string, target: string, bend: number): FloatingCurve | undefined {
  const from = useInternalNode(source), to = useInternalNode(target)
  if (!from || !to) return undefined
  return floatingCurve(center(from), center(to), bend)
}

const cap = (value: string) => value ? value[0]!.toUpperCase() + value.slice(1) : value

/** Words shown on an agent node; never inferred from a label. */
export type AgentFactsSource = Partial<Pick<Agent, 'harnessConfiguration' | 'harness' | 'productRole' | 'effort' | 'model' | 'harnessSummary'>>
export function agentNodeFacts(agent: AgentFactsSource, role?: string): {
  harness?: string; harnessLabel: string; model?: string; icon: IconName; roleLabel: string; meta: { label: string; value: string }[]
} {
  const configuration = agent.harnessConfiguration
  const harness = configuration?.harness ?? agent.harness
  const productRole = role ?? agent.productRole
  const roleLabel = productRole === 'orchestrator' ? 'Orchestrator' : productRole === 'coder' ? 'Worker'
    : productRole ? cap(productRole) : 'Agent'
  const effort = configuration ? configuration.harness === 'codex' ? configuration.reasoningEffort : configuration.variant || 'default' : agent.effort
  const meta = [
    ...(effort ? [{ label: configuration?.harness === 'opencode' ? 'Variant' : 'Effort', value: cap(String(effort)) }] : []),
    { label: 'Role', value: roleLabel },
  ]
  const lower = `${productRole ?? ''}`.toLowerCase()
  return {
    harness, harnessLabel: harness === 'codex' ? 'Codex' : harness === 'opencode' ? 'OpenCode' : agent.harnessSummary?.label ?? 'Harness not set',
    model: configuration?.model ?? agent.model, roleLabel, meta,
    icon: lower.includes('review') ? 'eye' : lower.includes('orchestrat') ? 'workflow' : lower.includes('cod') ? 'code' : 'bot',
  }
}

const sandboxLabels = { 'read-only': 'Read only', 'workspace-write': 'Can edit the workspace', 'danger-full-access': 'Full access' } as const

/** Effective configuration rows for the Info panel. */
export function agentSettingRows(agent: Agent): { label: string; value: string; mono?: boolean }[] {
  const facts = agentNodeFacts(agent), configuration = agent.harnessConfiguration
  return [
    { label: 'Harness', value: facts.harnessLabel },
    { label: 'Model', value: facts.model ?? 'Not set' },
    ...facts.meta.filter((item) => item.label !== 'Role'),
    ...(configuration?.harness === 'codex' ? [{ label: 'Sandbox', value: sandboxLabels[configuration.sandbox] }] : []),
    ...(configuration?.harness === 'opencode' ? [{ label: 'Permissions', value: configuration.autoApprove ? 'Approves automatically' : 'Asks when needed' }] : []),
  ]
}
