import {
  nextOccurrences, scheduleAdmissionDecision,
  type ScheduleAdmissionDecision, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'

export const SCHEDULE_DISPATCH_BATCH_SIZE = 100
export interface DueScheduleStep {
  dueAt: string
  nextDueAt: string | null
  decision: ScheduleAdmissionDecision
}

/** Bounded recovery. The extra recurrence is a lookahead, not permission to backfill.
 * A batch ending in the middle of a backlog contains ONLY missed outcomes; the
 * next tick continues from the committed cursor. Exactly five minutes is eligible. */
export function planDueSchedule(schedule: WorkflowSchedule, nowUtc: string,
  limit = SCHEDULE_DISPATCH_BATCH_SIZE): DueScheduleStep[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > SCHEDULE_DISPATCH_BATCH_SIZE) {
    throw new RangeError('Schedule dispatch batch size must be between 1 and 100.')
  }
  const due = schedule.nextOccurrenceAt
  if (!schedule.enabled || due === null || Date.parse(due) > Date.parse(nowUtc)) return []
  const result: DueScheduleStep[] = []
  let dueAt: string | null = due
  for (let index = 0; index < limit && dueAt !== null; index++) {
    if (Date.parse(dueAt) > Date.parse(nowUtc)) break
    // One lookahead avoids computing 100 future weeks for a routine firing.
    const nextDueAt: string | null = nextOccurrences(schedule, dueAt, 1)[0] ?? null
    result.push({ dueAt, nextDueAt, decision: scheduleAdmissionDecision({
      dueAt, nowUtc, enabled: true, hasOverlappingScheduledRun: false,
      isLatestDueOccurrence: nextDueAt === null || Date.parse(nextDueAt) > Date.parse(nowUtc),
    }) })
    dueAt = nextDueAt
  }
  return result
}

/** Re-evaluate after every lock/preflight wait. Stored nextOccurrenceAt is not a
 * recurrence input: a later due time supersedes this one even within grace. */
export function decideDueSchedule(schedule: WorkflowSchedule, dueAt: string,
  nowUtc: string, enabled: boolean, hasOverlappingScheduledRun: boolean): ScheduleAdmissionDecision {
  const next = nextOccurrences({ ...schedule, enabled: true }, dueAt, 1)[0]
  return scheduleAdmissionDecision({ dueAt, nowUtc, enabled, hasOverlappingScheduledRun,
    isLatestDueOccurrence: next === undefined || Date.parse(next) > Date.parse(nowUtc) })
}
