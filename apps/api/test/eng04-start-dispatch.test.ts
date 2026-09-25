import { describe, expect, it } from 'vitest'
import { RunStartV3InputSchema } from '@graphql/contracts/wave25'
import { runStartSemantics } from '../src/modules/runs/repeatStartDispatch.js'
import { startFixture } from './eng04-start-fixtures.js'

describe('ENG04 NATIVE-3 strict Start version/request discrimination', () => {
  it('preserves legacy omission and explicit 1/2 while retaining a distinct literal3 arm', () => {
    expect(runStartSemantics({})).toBe(1)
    expect(runStartSemantics({ executionSemanticsVersion: 1 })).toBe(1)
    expect(runStartSemantics({ executionSemanticsVersion: 2 })).toBe(2)
    expect(runStartSemantics({ executionSemanticsVersion: 3 })).toBe(3)
  })
  it.each([null, 0, -1, 4, 99, 2.5, '2', '3', true, {}, []])('never coerces unsupported semantics %j to legacy', (value) => {
    expect(() => runStartSemantics({ executionSemanticsVersion: value })).toThrowError(
      expect.objectContaining({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' }))
  })
  it('requires full displayed revision/configuration/version/location and paired draft pins', () => {
    const f = startFixture()
    expect(RunStartV3InputSchema.parse(f.request)).toEqual(f.request)
    for (const field of ['expectedWorkflowRevision', 'expectedAgentConfigurationVersionIds', 'workflowVersionId',
      'expectedLocationRevision', 'commandId', 'executionSemanticsVersion']) {
      const incomplete: Record<string, unknown> = { ...f.request }; delete incomplete[field]
      expect(RunStartV3InputSchema.safeParse(incomplete).success).toBe(false)
    }
    expect(RunStartV3InputSchema.safeParse({ ...f.request, draftId: 'draft-test' }).success).toBe(false)
    expect(RunStartV3InputSchema.safeParse({ ...f.request, expectedDraftRevision: 1 }).success).toBe(false)
    expect(RunStartV3InputSchema.safeParse({ ...f.request, runtimeReady: true }).success).toBe(false)
  })
})
