import { createHash } from 'node:crypto'
import type { MaintenanceTaskStart } from '@foreman-code/contracts/computer-maintenance'

export function syncFingerprint(task: MaintenanceTaskStart): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(task)).digest('hex')}`
}
