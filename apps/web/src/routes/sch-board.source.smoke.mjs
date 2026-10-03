// Source invariants only: these do NOT execute React, requests, guards or layout.
// Run separately with: node --test apps/web/src/routes/sch-board.source.smoke.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const router = read('../app/router.tsx')
const route = read('./WorkspaceRouteEntry.tsx')
const board = read('../features/workflow-board/WorkflowBoard.tsx')
const controls = read('../features/workflow-board/BoardNavigationControls.tsx')
const section = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)))

test('router switches only to the owned extended validator', () => {
  assert.match(router, /import \{ RunsSelectorSearchSchema \} from '\.\.\/features\/runs-selector'/)
  assert.match(router, /validateSearch: RunsSelectorSearchSchema/)
  assert.doesNotMatch(router, /WorkspaceBoardSearchSchema/)
})
test('route uses the owned resolver while preserving explicit identity validation', () => {
  assert.match(route, /resolveRunsSelectorBoardLocation as resolveWorkflowBoardLocation/)
  assert.match(route, /assertHistoryPin\(selection, location.search.selectedRunId\)/)
  assert.match(route, /!board.workflowId \|\| \(board.run && board.run.runId !== selectedRunId\)/)
})
test('both fallback guards and effect dependencies include the new history parameter', () => {
  assert.match(route, /if \(run \|\| selectedRunId\) return/)
  assert.match(route, /previous.runId \|\| previous.selectedRunId/)
  assert.match(route, /\[requestedId, run, selectedRunId, search.workflowId/)
})
test('explicit legacy/current writes strip the history parameter; unrelated agent writes preserve it', () => {
  const explicit = section(route, '  const selectRun =', '  const selectInspection =')
  assert.match(explicit, /boardSearchForRun\(withoutRunsSelectorSearch\(previous\), workflowId, scope\)/)
  assert.doesNotMatch(explicit, /selectedRunId:/)
  const agent = section(route, '  const selectDraftAgent =', '  if (workspace.isPending')
  assert.match(agent, /search: \(previous\) =>/)
  assert.match(agent, /boardSearchForRun\(withoutRunsSelectorSearch\(board.search\)/)
  assert.match(agent, /selectedRunId: previous.selectedRunId/)
  assert.match(agent, /hash: true/)
})
test('departure predicates receive two validated, projected searches', () => {
  const projection = section(route, 'function projectBoardDeparture', '/** Adapt')
  assert.ok(projection.indexOf('RunsSelectorSearchSchema.parse') < projection.indexOf('withoutRunsSelectorSearch'))
  assert.match(route, /from = projectBoardDeparture\(current\), to = projectBoardDeparture\(next\)/)
  assert.match(route, /staysOnWorkflowBoard\(from.target, to.target\)/)
  assert.match(route, /get current\(\) \{ return editor.current \}/)
  assert.match(route, /parent.request\(ids\)/)
})
test('scope-keyed current owner is retained inside a single shared-selection RunBoardSlot', () => {
  assert.match(route, /key=\{JSON.stringify\(\[workspaceId, workflowId\]\)\}/)
  assert.match(route, /run=\{run\}/)
  assert.equal((board.match(/= useSelectedRun\(/g) || []).length, 1)
  assert.match(controls, /<RunsSelector selection=\{selection\} \/>/)
  assert.match(board, /<RunBoardSlot selection=\{boardSelection\}>[\s\S]*\{children\}[\s\S]*<\/RunBoardSlot>/)
  assert.match(board, /run: legacyRun/)
  assert.match(board, /legacyRun \? <CurrentRunObserver scope=\{legacyRun\} \/>/)
  assert.doesNotMatch(board, /<SelectedRunCanvas/)
})
test('moved navigation preserves shared saved-ness, Run selection and Files controls', () => {
  assert.match(controls, /queryKey: boardDraftContextKey\(workspaceId, workflowId\)/)
  assert.match(controls, /nextDraftApi.context\(workspaceId, workflowId, \{ signal \}\)/)
  assert.match(controls, /isSaved=\{Boolean\(saved.data\?\.draft.baseWorkflowVersionId\)\}/)
  assert.match(controls, /<RunsSelector[^>]+\/>\s*<ScheduleClockButton[^>]+\/>\s*<WorkflowFilesButton/)
  assert.match(read('../features/graph/nextDraft/NextDraftEditor.tsx'), /\{board\?\.navigationControls\}/)
  assert.match(board, /navigationControls: current \? <BoardNavigationControls workspaceId=\{workspaceId\} workflowId=\{workflowId\} selection=\{selectedRun\}/)
})
test('portal, pending-operation and hidden keyboard/event fences remain in the mounted host', () => {
  assert.match(route, /dialog\[open\]:not\(\.workflow-board-runs-dialog\), \.n-agent-popover/)
  assert.match(route, /entry.current.busy \|\| entry.current.uncertain/)
  assert.match(route, /entry.current.scope === 'surface' && entry.current.dirty/)
  assert.match(board, /window.addEventListener\('keydown', shortcut, true\)/)
  assert.match(board, /window.removeEventListener\('keydown', shortcut, true\)/)
  assert.match(board, /onClickCapture=\{authoringEvent\} onKeyDownCapture=\{authoringEvent\} onSubmitCapture=\{authoringEvent\}/)
})
