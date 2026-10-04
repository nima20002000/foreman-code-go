import type { RunBoardNodeSnapshot } from '@graphql/contracts/run-snapshots'
import type { RunSubagent } from '@graphql/contracts/subagents'

export const isTerminalSubagent = (status: RunSubagent['status']) => ['completed', 'failed', 'canceled'].includes(status)
export type SubagentLayoutNode = Pick<RunBoardNodeSnapshot, 'id' | 'kind' | 'position' | 'size'>
export function layoutSubagents(nodes: readonly SubagentLayoutNode[], children: readonly RunSubagent[]) {
  const result: { subagent: RunSubagent; x: number; y: number; fromX: number; fromY: number; parentId: string }[] = []
  const ordered = [...children].sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.id.localeCompare(b.id))
  for (const node of nodes) {
    if (node.kind === 'job') continue
    const attached = ordered.filter((child) => child.parentNodeId === node.id)
    const visited = new Set<string>()
    let row = 0
    const attach = (parentId: string | null, fromX: number, fromY: number, depth: number) => {
      for (const child of attached.filter((item) => item.parentSubagentId === parentId)) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        const x = node.position.x + node.size.width + 56 + depth * 60
        const y = node.position.y + node.size.height / 2 + row++ * 52
        result.push({ subagent: child, x, y, fromX, fromY, parentId: parentId ?? node.id })
        attach(child.id, x, y, depth + 1)
      }
    }
    attach(null, node.position.x + node.size.width, node.position.y + node.size.height / 2, 0)
  }
  return result
}
