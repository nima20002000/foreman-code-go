import { expect, it } from 'vitest'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import { mainTarget, deviceTarget } from './computersTestFixture'
import { reorderEdits } from './useComputerEdits'

const statuses: readonly BuildComputerStatus[] = [mainTarget, deviceTarget].map((target, index) => ({
  preference: { target, revision: 1, buildEnabled: true, buildPriority: 100 - index * 50,
    buildRole: 'primary', buildAllowancePercent: 60 },
  state: 'ready', reasons: [], remoteExecutionEnabled: true,
}))

it.each([[-1, 0], [-2, 1], [2, 0], [0, -1], [0, 2]])(
  'returns no edits when a reorder index is outside the computer list (%i to %i)', (from, to) => {
    const before = structuredClone(statuses)
    expect(reorderEdits(statuses, from, to)).toEqual([])
    expect(statuses).toEqual(before)
  },
)
it('reorders valid computers without changing the input snapshot', () => {
  const before = structuredClone(statuses)
  const edits = reorderEdits(statuses, 1, 0)
  expect(edits.map(edit => edit.target)).toEqual([deviceTarget, mainTarget])
  expect(edits.map(edit => edit.buildPriority)).toEqual([100, 0])
  expect(edits.map(edit => edit.expectedRevision)).toEqual([1, 1])
  expect(statuses).toEqual(before)
})
