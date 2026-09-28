import { describe, expect, it, vi } from 'vitest'
import type { ScheduleConfiguration } from '@graphql/contracts/schedules'
import { buildScheduleCommand, createDraft, createScheduleEditorStore, draftIdentity, timezoneOptions } from './editorStore'

const scope = { workspaceId: 'workspace-test', workflowId: 'workflow-test' }
const now = '2026-09-28T10:00:00.000Z'
const weekly: ScheduleConfiguration = { mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC', enabled: true, policy: 'latest_saved' }
function editor(value: ScheduleConfiguration | null = weekly, revision = 3) {
  const store = createScheduleEditorStore()
  store.getState().initialize(value, revision)
  return store
}

describe('schedule form validation and draft ownership', () => {
  it('uses revision zero for absence without inventing a server record', () => {
    const store = editor(null, 0)
    expect(store.getState().expectedRevision).toBe(0)
    expect(buildScheduleCommand(scope, store.getState(), now).command?.input.expectedRevision).toBe(0)
  })
  it.each(['', '0', '-1', '1.5', 'Infinity', '1e3', '9007199254740992'])('rejects invalid interval %s', (every) => {
    const store = editor()
    store.getState().edit({ mode: 'interval', every })
    expect(buildScheduleCommand(scope, store.getState(), now).errors?.every).toBeDefined()
  })
  it.each(['minute', 'hour'] as const)('anchors a new %s interval one period after save time', (unit) => {
    const store = editor()
    store.getState().edit({ mode: 'interval', every: '2', unit })
    const result = buildScheduleCommand(scope, store.getState(), now)
    expect(result.command?.kind).toBe('save')
    if (result.command?.kind !== 'save') throw new Error('Expected save')
    expect(result.command.input.schedule).toMatchObject({ mode: 'interval', every: 2, unit,
      anchorAt: new Date(Date.parse(now) + 2 * (unit === 'minute' ? 60_000 : 3_600_000)).toISOString() })
  })
  it('does not reset an existing interval anchor when opening or editing', () => {
    const anchorAt = '2025-01-01T00:00:00.000Z'
    const store = editor({ mode: 'interval', every: 5, unit: 'minute', anchorAt, timezone: 'UTC', enabled: true, policy: 'latest_saved' })
    store.getState().edit({ every: '10' })
    const result = buildScheduleCommand(scope, store.getState(), now)
    if (result.command?.kind !== 'save') throw new Error('Expected save')
    expect(result.command.input.schedule).toMatchObject({ anchorAt, every: 10 })
  })
  it('requires at least one weekday, a valid time, and a supported zone', () => {
    const store = editor()
    store.getState().edit({ weekdays: [], time: '', timezone: 'PST' })
    expect(buildScheduleCommand(scope, store.getState(), now).errors).toMatchObject({
      weekdays: 'Choose a day.', time: 'Choose a time.', timezone: 'Choose a timezone.',
    })
  })
  it.each(['2026-09-27', '2026-02-30', '0000-01-01'])('rejects invalid/past Once %s even disabled', (localDate) => {
    const store = editor(null, 0)
    store.getState().edit({ mode: 'once', localDate, time: '09:00', timezone: 'UTC', enabled: false })
    expect(buildScheduleCommand(scope, store.getState(), now).errors?.localDate).toBeDefined()
  })
  it('uses the frozen first-fold rule for Once validation', () => {
    const store = editor(null, 0)
    store.getState().edit({ mode: 'once', localDate: '2026-11-01', time: '01:30', timezone: 'America/New_York' })
    expect(buildScheduleCommand(scope, store.getState(), '2026-11-01T05:45:00.000Z').errors?.localDate).toBeDefined()
  })
  it('disables an unchanged exhausted Once through the dedicated command', () => {
    const store = editor({ mode: 'once', localDate: '2020-01-01', time: '09:00', timezone: 'UTC', enabled: true, policy: 'latest_saved' })
    store.getState().edit({ enabled: false })
    expect(buildScheduleCommand(scope, store.getState(), now)).toEqual({
      command: { kind: 'disable', input: { ...scope, expectedRevision: 3 } },
    })
    store.getState().edit({ time: '10:00' })
    expect(buildScheduleCommand(scope, store.getState(), now).errors?.localDate).toBeDefined()
  })
  it('keeps saved aliases in the timezone select', () => {
    expect(timezoneOptions('US/Eastern')).toEqual(expect.arrayContaining(['UTC', 'US/Eastern']))
  })
  it('keeps the browser zone available when Intl has no timezone list', () => {
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
    const localZone = 'Asia/Dushanbe'
    vi.stubGlobal('Intl', Object.assign(Object.create(Intl), { supportedValuesOf: undefined }))
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...resolvedOptions.call(this), timeZone: localZone }
    })
    try {
      const saved = editor()
      expect(timezoneOptions(saved.getState().draft!.timezone)).toContain(localZone)

      const fresh = editor(null, 0)
      expect(fresh.getState().draft?.timezone).toBe(localZone)
      fresh.getState().edit({ timezone: 'UTC' })
      expect(timezoneOptions(fresh.getState().draft!.timezone)).toContain(localZone)
      const result = buildScheduleCommand(scope, fresh.getState(), now)
      if (result.command?.kind !== 'save') throw new Error('Expected save')
      const reopened = editor(result.command.input.schedule, 1)
      expect(timezoneOptions(reopened.getState().draft!.timezone)).toContain(localZone)
      reopened.getState().edit({ timezone: localZone })
      expect(timezoneOptions(reopened.getState().draft!.timezone)).toContain('UTC')
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })
  it('compares only the selected tab, ignoring weekday order', () => {
    const draft = createDraft(weekly)
    expect(draftIdentity({ ...draft, weekdays: [3, 1], every: '100' })).toBe(draftIdentity({ ...draft, weekdays: [1, 3] }))
  })
  it('isolates stores and discards only the explicitly closed draft', () => {
    const first = editor(), second = editor()
    first.getState().show()
    first.getState().initialize(weekly, 3)
    first.getState().edit({ time: '23:00' })
    expect(second.getState().draft?.time).toBe('09:00')
    first.getState().hide()
    expect(first.getState().draft).toBeNull()
    expect(second.getState().draft?.time).toBe('09:00')
  })
})
