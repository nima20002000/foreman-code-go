import { createStore } from 'zustand/vanilla'
import { ZodError } from 'zod'
import {
  parseScheduleSaveInput, ScheduleTimeZoneSchema,
  type ScheduleConfiguration, type ScheduleGetInput,
} from '@graphql/contracts/schedules'
import type { NewScheduleCommand } from './queries'

export type ScheduleMode = ScheduleConfiguration['mode']
/** Form strings deliberately admit incomplete/invalid input; this is not an API shape. */
export interface ScheduleDraft {
  mode: ScheduleMode
  weekdays: number[]
  time: string
  every: string
  unit: 'minute' | 'hour'
  anchorAt?: string
  localDate: string
  timezone: string
  enabled: boolean
}
export type DraftErrors = Partial<Record<'weekdays' | 'time' | 'every' | 'localDate' | 'timezone' | 'form', string>>

export function browserTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return ScheduleTimeZoneSchema.safeParse(zone).success ? zone : 'UTC'
  } catch { return 'UTC' }
}
export function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  let zones: string[] = []
  try { zones = intl.supportedValuesOf?.('timeZone') ?? [] } catch { /* Browser zone and UTC remain usable. */ }
  // Intl's canonical list can omit aliases already persisted by the service.
  return [...new Set(['UTC', browserTimezone(), current, ...zones])].sort()
}
function tomorrow(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(Date.now() + 86_400_000)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? ''
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`
}
export function createDraft(value: ScheduleConfiguration | null): ScheduleDraft {
  const timezone = value?.timezone ?? browserTimezone()
  return {
    mode: value?.mode ?? 'weekly', timezone, enabled: value?.enabled ?? true,
    weekdays: value?.mode === 'weekly' ? [...value.weekdays].sort((a, b) => a - b) : [1, 2, 3, 4, 5],
    time: value?.mode === 'weekly' || value?.mode === 'once' ? value.time : '09:00',
    every: value?.mode === 'interval' ? String(value.every) : '1',
    unit: value?.mode === 'interval' ? value.unit : 'hour',
    anchorAt: value?.mode === 'interval' ? value.anchorAt : undefined,
    localDate: value?.mode === 'once' ? value.localDate : tomorrow(timezone),
  }
}

/** Ignore inactive tab fields; changing tabs back does not manufacture a settings edit. */
export function draftIdentity(draft: ScheduleDraft, includeEnabled = true): string {
  const common = { mode: draft.mode, timezone: draft.timezone, ...(includeEnabled ? { enabled: draft.enabled } : {}) }
  return JSON.stringify(draft.mode === 'weekly' ? { ...common, weekdays: [...draft.weekdays].sort((a, b) => a - b), time: draft.time }
    : draft.mode === 'once' ? { ...common, localDate: draft.localDate, time: draft.time }
      : { ...common, every: draft.every, unit: draft.unit, anchorAt: draft.anchorAt })
}

interface EditorState {
  open: boolean
  draft: ScheduleDraft | null
  // These are draft comparison/optimistic-concurrency tokens, not another server cache.
  initialIdentity: string
  initialSettings: string
  expectedRevision: number
  errors: DraftErrors
  show(): void
  hide(): void
  initialize(value: ScheduleConfiguration | null, revision: number): void
  edit(patch: Partial<ScheduleDraft>): void
  setErrors(errors: DraftErrors): void
  resetDraft(): void
}
export function createScheduleEditorStore() {
  return createStore<EditorState>((set) => ({
    open: false, draft: null, initialIdentity: '', initialSettings: '', expectedRevision: 0, errors: {},
    show: () => set({ open: true, draft: null, errors: {} }),
    hide: () => set({ open: false, draft: null, errors: {} }),
    initialize: (value, revision) => {
      const draft = createDraft(value)
      set({ draft, expectedRevision: revision, initialIdentity: draftIdentity(draft), initialSettings: draftIdentity(draft, false), errors: {} })
    },
    edit: (patch) => set((state) => ({ draft: state.draft ? { ...state.draft, ...patch } : null, errors: {} })),
    setErrors: (errors) => set({ errors }),
    resetDraft: () => set({ draft: null, errors: {} }),
  }))
}
export type ScheduleEditorStore = ReturnType<typeof createScheduleEditorStore>

export function buildScheduleCommand(
  scope: ScheduleGetInput, state: Pick<EditorState, 'draft' | 'initialSettings' | 'expectedRevision'>,
  nowUtc = new Date().toISOString(),
): { command: NewScheduleCommand; errors?: never } | { errors: DraftErrors; command?: never } {
  const { draft, expectedRevision } = state
  if (!draft) return { errors: { form: 'Load schedule first.' } }
  // Disabling the unchanged record must also work for an exhausted/past Once.
  if (expectedRevision > 0 && !draft.enabled && draftIdentity(draft, false) === state.initialSettings) {
    return { command: { kind: 'disable', input: { ...scope, expectedRevision } } }
  }
  const common = { timezone: draft.timezone, enabled: draft.enabled, policy: 'latest_saved' as const }
  const every = /^\d+$/.test(draft.every) ? Number(draft.every) : NaN
  if (draft.mode === 'interval' && (!Number.isSafeInteger(every) || every < 1)) {
    return { errors: { every: 'Use a whole number ≥ 1.' } }
  }
  const newAnchor = Date.parse(nowUtc) + every * (draft.unit === 'minute' ? 60_000 : 3_600_000)
  if (draft.mode === 'interval' && !draft.anchorAt && (!Number.isFinite(newAnchor) || newAnchor > Date.parse('9999-12-31T23:59:59.999Z'))) {
    return { errors: { every: 'Interval is too large.' } }
  }
  const schedule = draft.mode === 'weekly' ? { ...common, mode: draft.mode, weekdays: draft.weekdays, time: draft.time }
    : draft.mode === 'once' ? { ...common, mode: draft.mode, localDate: draft.localDate, time: draft.time }
      : { ...common, mode: draft.mode, every, unit: draft.unit, anchorAt: draft.anchorAt ?? new Date(newAnchor).toISOString() }
  try {
    // This browser clock is only an early validation hint. The service validates its
    // own clock, after replay lookup. No occurrence preview is presented as server truth.
    const parsed = parseScheduleSaveInput({
      ...scope, expectedRevision, commandId: 'schedule-validation', schedule,
    }, nowUtc)
    return { command: { kind: 'save', input: { ...scope, expectedRevision, schedule: parsed.schedule } } }
  } catch (error) {
    if (!(error instanceof ZodError)) return { errors: { form: 'Check schedule.' } }
    const errors: DraftErrors = {}
    for (const issue of error.issues) {
      switch (issue.path[1]) {
        case 'weekdays': errors.weekdays = 'Choose a day.'; break
        case 'time': errors.time = 'Choose a time.'; break
        case 'every': errors.every = 'Use a whole number ≥ 1.'; break
        case 'localDate': errors.localDate = 'Choose a future date and time.'; break
        case 'timezone': errors.timezone = 'Choose a timezone.'; break
        default: errors.form = 'Check schedule.'
      }
    }
    return { errors }
  }
}
