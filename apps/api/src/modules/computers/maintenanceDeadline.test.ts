import { expect, it } from 'vitest'
import type { WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

it('fails a Worker update task whose restart never reports back after 60 minutes, and keeps that result', async () => {
  const computer = fakeComputer()
  let now = Date.parse('2026-10-15T08:00:00.000Z')
  let worker: WorkerUpdateStatus = { currentVersion: '1.0.0', targetVersion: null, state: 'current', lastError: null }
  const ports = { ...computer.ports, now: () => new Date(now), workerUpdate: { status: async () => worker,
    start: async () => {
      worker = { ...worker, targetVersion: '1.1.0', state: 'restarting' }
      return 'Worker 1.1.0 restart is scheduled.'
    } } }
  const maintenance = new ComputerMaintenance(ports)
  const task = await maintenance.start({ kind: 'update-worker' })
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await maintenance.status(AbortSignal.timeout(2000))).tasks[0]?.workerTargetVersion) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }

  now += 59 * 60_000
  expect((await maintenance.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'running' })
  now += 2 * 60_000
  const failed = (await maintenance.status(AbortSignal.timeout(2000))).tasks[0]
  expect(failed).toMatchObject({ id: task.id, state: 'failed', finishedAt: new Date(now).toISOString() })
  expect(failed?.summary).toMatch(/^MAINTENANCE_TASK_DEADLINE_EXCEEDED: phase worker-restart, age 61 min, over the 60 min limit\./u)
  expect(failed?.summary).toContain('not confirmed stopped')

  // A late Worker report does not turn the expired task into a success.
  worker = { currentVersion: '1.1.0', targetVersion: '1.1.0', state: 'current', lastError: null }
  expect((await maintenance.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'failed' })
  // The saved task list keeps the failure for a restarted process.
  const restarted = new ComputerMaintenance(ports)
  expect((await restarted.status(AbortSignal.timeout(2000))).tasks[0]).toMatchObject({ id: task.id, state: 'failed' })
})
