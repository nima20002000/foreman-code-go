import type { MaintenanceTask, WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'

export interface MaintenancePorts {
  environment: NodeJS.ProcessEnv
  /** Absolute executable path, or null when not installed. */
  find(name: string): Promise<string | null>
  run(binary: string, args: string[], options: { signal: AbortSignal; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }>
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string | null>
  /** Writes a private (0600) file atomically, creating its directory. */
  writePrivateText(path: string, text: string): Promise<void>
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>
  /** Runs fn after ms; restart uses it so the reply reaches Main before the computer goes down. */
  later(fn: () => void, ms: number): void
  now(): Date
  /** Moves this computer's runtime selection to the installed update. Qualification still checks the selected binary. */
  selectInstalledCodex?(signal: AbortSignal): Promise<string | null>
  workerUpdate?: {
    status(): Promise<WorkerUpdateStatus>
    start(options: { retry: boolean }): Promise<string>
    /** Returns a retained outcome only when it completed by the task's deadline. */
    outcome?(task: MaintenanceTask, deadlineAt: string): Promise<WorkerUpdateStatus | null>
  }
}
