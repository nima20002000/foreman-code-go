import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'

installBoardTestLifecycle()

it('resizes a Run node through layout Save and shows the persisted circle on the draft and Run', async () => {
  installFlowLayout(1000, 720)
  const fixture = await inspectionBoardFixture('circle-resize')
  const scope = fixture.runs.before.scope
  const originalVersion = structuredClone(fixture.mock.versions.get(scope.workflowVersionId))
  const originalRun = structuredClone(fixture.mock.runs.get(scope.runId))
  const wire = measureBoardWire(fixture.mock)
  const { history, container } = await mountMeasuredBoard(boardHref(scope))
  const label = fixture.first.name ?? fixture.first.label ?? fixture.first.id
  const ring = await screen.findByRole('slider', { name: `Resize ${label}` })
  expect(ring).toHaveAttribute('tabindex', '0')
  const initial = Number(ring.getAttribute('aria-valuenow'))
  fireEvent.keyDown(ring, { key: 'ArrowRight' })
  await waitFor(() => expect(ring).toHaveAttribute('aria-valuenow', String(initial + 8)))
  const key = nextDraftKey(scope.workspaceId, scope.workflowId)
  await waitFor(() => {
    expect(useGraphDraftStore.getState().nextDrafts[key]!.context.draft.graph.nodes[0]).toMatchObject({
      width: initial + 8, height: initial + 8,
    })
  })
  expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
  expect(wire.writes()).toHaveLength(1)
  expect(wire.writes()[0]).toMatchObject({ method: 'PUT', status: 200 })
  expect(fixture.mock.workflows.get(scope.workflowId)!.nodes[0]).toMatchObject({ width: initial + 8, height: initial + 8 })
  expect(fixture.mock.versions.get(scope.workflowVersionId)).toEqual(originalVersion)
  expect(fixture.mock.runs.get(scope.runId)).toEqual(originalRun)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /^Runs$/ }))
  await user.click(await screen.findByRole('menuitemradio', { name: 'New run' }))
  const draftRing = await screen.findByRole('slider', { name: `Resize ${label}` })
  expect(draftRing).toHaveAttribute('aria-valuenow', String(initial + 8))
  expect(container.querySelector('.react-flow__resize-control')).toBeNull()
  await history.back()
  await waitFor(() => expect(screen.getByLabelText('Selected Run pinned topology')).toBeInTheDocument())
  expect(await screen.findByRole('slider', { name: `Resize ${label}` })).toHaveAttribute('aria-valuenow', String(initial + 8))
}, 15_000)
