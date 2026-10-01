import { describe, expect, it } from 'vitest'
import { ActivitySnapshotV1Schema, projectActivityStatus } from './activity.js'
import { activitySnapshotFixtures as fixtures } from './activityFixtures.js'
describe('Activity v1 ownership projection', () => {
  it('preserves older active A independently of newer queued/latest B', () => {
    const value = fixtures.activeBeforeNewerQueued
    expect(value.active[0]?.ref).toMatchObject({ requestId: 'A' })
    expect(value.queued).toEqual([{ kind: 'chat_request', conversationId: 'conversation', requestId: 'B' }])
    expect(value.latest).toEqual(value.queued[0])
  })
  it('keeps interruption and uncertainty separate from proven outcomes', () => {
    expect(fixtures.interrupting.active[0]?.outcome).toBeNull()
    expect(fixtures.uncertainDelivery.active[0]).toMatchObject({ evidence: 'reconciling', delivery: 'unknown', outcome: null })
  })
  it('does not settle unresolved children with their parent', () => {
    expect(fixtures.terminalParentUnresolvedChild.active).toHaveLength(1)
    expect(fixtures.terminalParentUnresolvedChild.active[0]).toMatchObject({ ref: { kind: 'subagent' }, outcome: null, evidence: 'unknown' })
  })
  it('retains multiple active executions without newest-wins selection', () => {
    const work = fixtures.activeBeforeNewerQueued.active[0]!
    const execution = { kind: 'execution' as const, workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version', executionId: 'one', attemptKey: 'attempt' }
    expect(projectActivityStatus({ work: [{ ...work, ref: execution }, { ...work, ref: { ...execution, executionId: 'two' } }], queued: [], latest: execution }).active).toHaveLength(2)
  })
  it('validates fixtures and rejects transport/raw fields and numeric revisions', () => {
    for (const fixture of Object.values(fixtures)) expect(ActivitySnapshotV1Schema.safeParse(fixture).success).toBe(true)
    expect(ActivitySnapshotV1Schema.safeParse({ ...fixtures.idle, revision: 12 }).success).toBe(false)
    expect(ActivitySnapshotV1Schema.safeParse({ ...fixtures.idle, connection: 'connected' }).success).toBe(false)
  })
})
