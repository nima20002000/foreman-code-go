import type { RunBoardNodeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { RunSubagent } from '@foreman-code/contracts/subagents'

export const isTerminalSubagent = (status: RunSubagent['status']) => ['completed', 'failed', 'canceled'].includes(status)
export type SubagentLayoutNode = Pick<RunBoardNodeSnapshot, 'id' | 'kind' | 'position' | 'size'>

/** Chip geometry shared with the stylesheet. */
export const SUBAGENT_CHIP = { height: 28, gap: 8, indent: 22, below: 18 } as const

/**
 * Children hang below their parent node as an indented tree, so they never
 * cover the downstream nodes of a left-to-right workflow. (x, y) is the chip's
 * top-left corner; the connector runs down a spine at spineX from fromY, then
 * across to the chip's vertical middle.
 */
export function layoutSubagents(nodes: readonly SubagentLayoutNode[], children: readonly RunSubagent[]) {
  const result: { subagent: RunSubagent; x: number; y: number; spineX: number; fromY: number; parentId: string }[] = []
  const ordered = [...children].sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.id.localeCompare(b.id))
  for (const node of nodes) {
    if (node.kind === 'job') continue
    const attached = ordered.filter((child) => child.parentNodeId === node.id)
    const visited = new Set<string>()
    let row = 0
    const top = node.position.y + node.size.height + SUBAGENT_CHIP.below
    const attach = (parentId: string | null, spineX: number, fromY: number) => {
      for (const child of attached.filter((item) => item.parentSubagentId === parentId)) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        const x = spineX + SUBAGENT_CHIP.indent
        const y = top + row++ * (SUBAGENT_CHIP.height + SUBAGENT_CHIP.gap)
        result.push({ subagent: child, x, y, spineX, fromY, parentId: parentId ?? node.id })
        attach(child.id, x + SUBAGENT_CHIP.indent / 2, y + SUBAGENT_CHIP.height)
      }
    }
    attach(null, node.position.x + 24, node.position.y + node.size.height)
  }
  return result
}
