import type { QueryClient } from '@tanstack/react-query'
import { ScheduleConfigurationSchema, type ScheduleGetInput, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { boardScope, recordBoardAction } from '../workflow-board/boardUndo'
import { scheduleApi } from './client'
import { scheduleKeys } from './queries'

/** Restores one saved schedule state (null: no schedule, so it is turned off) at the server's current revision. */
async function restoreSchedule(scope: ScheduleGetInput, target: WorkflowSchedule | null, client: QueryClient) {
  const current = (await scheduleApi.get(scope)).schedule
  const expectedRevision = current?.revision ?? 0
  let value: WorkflowSchedule | undefined
  if (target) {
    const record = new Set(['workspaceId', 'workflowId', 'revision', 'nextOccurrenceAt'])
    const settings = Object.fromEntries(Object.entries(target).filter(([key]) => !record.has(key)))
    value = (await scheduleApi.save({ ...scope, commandId: crypto.randomUUID(), expectedRevision,
      schedule: ScheduleConfigurationSchema.parse(settings) })).value
  } else if (current?.enabled) {
    value = (await scheduleApi.disable({ ...scope, commandId: crypto.randomUUID(), expectedRevision })).value
  }
  if (value) client.setQueryData(scheduleKeys.read(scope), { schedule: value })
  await client.invalidateQueries({ queryKey: scheduleKeys.read(scope), exact: true })
}

/** A saved schedule change joins the Board's undo history. */
export function recordScheduleUndo(scope: ScheduleGetInput, previous: WorkflowSchedule | null, next: WorkflowSchedule, client: QueryClient) {
  const label = !previous ? 'schedule set' : !next.enabled && previous.enabled ? 'schedule turned off'
    : next.enabled && !previous.enabled ? 'schedule turned on' : 'schedule change'
  recordBoardAction(boardScope(scope.workspaceId, scope.workflowId), { label,
    undo: () => restoreSchedule(scope, previous, client), redo: () => restoreSchedule(scope, next, client) })
}
