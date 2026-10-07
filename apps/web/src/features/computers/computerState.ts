import type { ComputerActivity } from '@foreman-code/contracts/computer-activity'

export function computerState(computer: ComputerActivity | undefined, complete: boolean) {
  if (!computer) return 'Unavailable'
  if (!computer.online) return 'Offline'
  if (computer.jobs.length) return 'Building'
  if (computer.agents.length) return 'Running agents'
  return complete ? 'Idle' : 'Activity restricted'
}
