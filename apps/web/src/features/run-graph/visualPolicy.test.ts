import { describe, it, expect } from 'vitest'
import { RunGraphSnapshotSchema } from '@graphql/contracts/wave25'
import { registerVisualCases } from './visualPolicy.cases'
import { addVisualApproval, addVisualReceipt, makeVisualFixture } from './fixtures/visualFixture'

describe('Agent 8 evidence and bounded-effect regressions', () => registerVisualCases(it))
describe('synthetic fixture contract qualification (not renderer performance evidence)', () => {
  it.each([100, 300, 500])('validates the %i-node fixture against the frozen schema', (count) => {
    const record = addVisualApproval(addVisualReceipt(makeVisualFixture(count), 1), 2)
    expect(RunGraphSnapshotSchema.safeParse(record.facts.snapshot).success).toBe(true)
  })
})
