import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Linter } from 'eslint'
import config from '../index.mjs'

const linter = new Linter({ configType: 'flat' })

function messages(code, filename = 'src/workflow.mjs') {
  return linter.verify(code, config, { filename }).map((message) => message.message)
}

function assertReports(code, expected, filename) {
  const reported = messages(code, filename)
  assert.ok(reported.some((message) => message.includes(expected)), `expected "${expected}" in ${JSON.stringify(reported)}`)
}

function assertClean(code, filename) {
  assert.deepEqual(messages(code, filename), [])
}

describe('ticket references', () => {
  it('reports ticket codes in file names, names, comments and test titles', () => {
    assertReports('export const ready = true\n', 'File name', 'src/nim2644EditIntent.mjs')
    assertReports('export const wave25Repository = {}\n', 'Name "wave25Repository"')
    assertReports('// ENG-04 keeps this path\nexport const ready = true\n', 'Comment contains a ticket code')
    assertReports("it('FIL-05 saves files', () => {})\n", 'Test title', 'test/files.test.mjs')
  })

  it('allows ordinary words that contain the same letters', () => {
    assertClean('export const engine = {}\nexport const filter10 = 1\nexport const preview = 2\n')
  })
})

describe('module-level names', () => {
  it('reports Current/Next prefixes and version suffixes on module-level declarations', () => {
    assertReports('export const CurrentRunSchema = {}\n', 'Current/Next')
    assertReports('export function NextDraftEditor() {}\n', 'Current/Next')
    assertReports('export const WorkflowDefinitionV3Schema = {}\n', 'version suffixes')
  })

  it('allows the same words on locals', () => {
    assertClean('export function step(items) {\n  const nextIndex = items.length\n  return nextIndex\n}\n')
  })
})

describe('error handling and parameters', () => {
  it('reports swallowed errors, boolean flags and voided parameters', () => {
    assertReports('export const run = (task) => task.catch(() => undefined)\n', 'promise rejections')
    assertReports('export function read() {\n  try {\n    return 1\n  } catch {\n    // ignore\n  }\n}\n', 'catch block')
    assertReports('export function close(session, restart = false) {\n  return [session, restart]\n}\n', 'boolean flag')
    assertReports('export function start(_context) {\n  void _context\n}\n', 'unused parameters')
  })
})

describe('density', () => {
  it('reports nested ternaries, comma declarations and several statements on one line', () => {
    assertReports('export const label = (a, b) => a ? 1 : b ? 2 : 3\n', 'Do not nest ternary')
    assertReports('const first = 1, second = 2\nexport const sum = first + second\n', "Split 'const' declarations")
    assertReports('let total = 0; total += 1\nexport { total }\n', 'Maximum allowed is 1')
  })

  it('ignores inline disable comments', () => {
    assertReports('// eslint-disable-next-line no-nested-ternary\nexport const label = (a, b) => a ? 1 : b ? 2 : 3\n',
      'Do not nest ternary')
  })
})

describe('tests', () => {
  it('reports tests that read source text', () => {
    assertReports("import source from './Editor.tsx?raw'\nexport { source }\n", 'not read source text', 'src/Editor.test.mjs')
    assertReports("export const path = read('../src/runs/engine.ts')\n", 'not read source files', 'test/engine.test.mjs')
  })
})
