import type {
  ComputerMaintenanceList, ComputerMaintenanceOperatorList, ComputerMaintenanceOperatorListInput,
  MaintenanceTaskKind,
} from '@foreman-code/contracts/computer-maintenance'

export function maintenanceReadResult(
  result: ComputerMaintenanceList,
  input: ComputerMaintenanceOperatorListInput,
  now = Date.now(),
): ComputerMaintenanceOperatorList {
  const failureCutoff = now - 24 * 60 * 60 * 1000
  return { computers: result.computers.map(computer => {
    if (!computer.status) return computer
    const status = computer.status
    if (input.detail === 'full') {
      const tasks = input.taskId ? status.tasks.filter(task => task.id === input.taskId) : status.tasks
      return { ...computer, status: { ...status, tasks } }
    }
    const latestKinds = new Set<MaintenanceTaskKind>()
    const tasks = [...status.tasks]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .filter(task => {
        const latest = !latestKinds.has(task.kind)
        latestKinds.add(task.kind)
        const finishedAt = Date.parse(task.finishedAt ?? task.startedAt)
        const recentFailure = task.state === 'failed' && finishedAt >= failureCutoff && finishedAt <= now
        return latest || recentFailure
      })
      .map(({ outputTail: _outputTail, ...task }) => ({
        ...task,
        summary: task.summary.length > 300 ? `${task.summary.slice(0, 299)}…` : task.summary,
      }))
    return { ...computer, status: { ...status, tasks } }
  }) }
}
