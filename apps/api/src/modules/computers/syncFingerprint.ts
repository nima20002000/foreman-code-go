import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { MaintenanceTaskStart } from '@foreman-code/contracts/computer-maintenance'

export function syncFingerprint(task: MaintenanceTaskStart): string {
  return commandInputHash(task)
}
