/** Dependency-free source architecture guard, not a runtime/native qualification.
 * Run via the existing web test entry before the mounted Vitest suite. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const web = resolve(here, '../..'), repo = resolve(web, '../../..')
const read = (path) => readFileSync(resolve(repo, path), 'utf8')
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)])
const source = walk(web).filter((path) => /\.tsx?$/.test(path))
test('every retained local Web import resolves after retirement', () => {
  const missing = []
  for (const file of source) {
    const body = readFileSync(file, 'utf8')
    for (const match of body.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\s+from\s*)?['"](\.[^'"]+)['"]/gm)) {
      let target = resolve(dirname(file), match[1].split('?')[0])
      if (/\.(js|jsx)$/.test(target)) target = target.replace(/\.(js|jsx)$/, '')
      if (![target, ...['.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js'].map((suffix) => target + suffix)].some(existsSync)) missing.push(`${file}: ${match[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})
test('mounted routes select the current persisted boundary, not a conversion editor', () => {
  const route = read('apps/web/src/routes/WorkspaceRouteEntry.tsx')
  assert.match(route, /PersistedWorkflowBoundary/)
  assert.doesNotMatch(route, /EnableTypedDraftButton|requestConversion|LegacyWorkflow|WorkflowDefinitionV2/)
  assert.deepEqual(existsSync(resolve(web, 'features/run-graph')) ? walk(resolve(web, 'features/run-graph')).filter((path) => /\.tsx?$/.test(path)) : [], [])
  assert.equal(existsSync(resolve(web, 'features/graph/GraphEditor.tsx')), false)
})
test('current Web execution imports and literals have no retired positive path', () => {
  for (const file of source.filter((path) => !/test|cases|testSupport|mocks/.test(path))) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /\b(?:WorkflowDefinitionV2|WorkflowVersionV2|WorkflowRunV2|GraphDraftV2|ManualRunStartInputSchema|SavedWorkflowDefinitionSchema)\b/, file)
    assert.doesNotMatch(text, /executionSemanticsVersion\s*:\s*[12]\b/, file)
  }
})
test('ordinary V3 omits repeat and the shared schema makes only configured finite plans optional', () => {
  assert.match(read('packages/contracts/src/wave25/workflowShape.ts'), /repeat:\s*RepeatPlanV1Schema\.optional\(\)/)
  assert.match(read('apps/web/src/features/repeats/RepeatEditor.tsx'), /repeat:\s*_removed,\s*\.\.\.ordinary/)
  assert.doesNotMatch(read('apps/web/src/shared/mocks/currentWorkflow.ts'), /repeat:\s*\{/)
  assert.doesNotMatch(read('packages/contracts/src/wave25/currentWorkflowFoundation.ts'), /WorkflowVersionV2Schema|WorkflowDefinitionV2Schema|executionSemanticsVersion:\s*2/)
})
test('mounted S3 coverage retains real route, Board, editor and clients', () => {
  const suite = read('apps/web/src/features/workflow-board/boardV3.integration.test.tsx')
  assert.match(suite, /routeTree.*from '..\/..\/app\/router'/)
  assert.doesNotMatch(suite, /vi\.mock\(/)
  for (const shape of ['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat-ready']) assert.ok(suite.includes(`'${shape}'`), shape)
  assert.match(suite, /Remove repeat/)
  assert.match(suite, /Reconcile Start/)
  assert.match(suite, /Stop affected Runs and save/)
})
