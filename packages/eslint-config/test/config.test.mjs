import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import config from '../index.mjs'

const linter = new Linter({ configType: 'flat' })
const configWithTypeScript = [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }, ...config]

function messages(code, filename = 'src/workflow.mjs') {
  return linter.verify(code, configWithTypeScript, { filename }).map((message) => message.message)
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

describe('tests that lock in source code', () => {
  const testFile = 'test/engine.test.ts'

  it('reports tests that read or evaluate source files', () => {
    assertReports("import source from './Editor.tsx?raw'\nexport { source }\n", 'not read source text', 'src/Editor.test.mjs')
    assertReports("export const path = read('../src/runs/engine.ts')\n", 'not read source files', testFile)
    assertReports("export const text = readFileSync(resolve(repo, 'apps/web/src/Board.tsx'))\n", 'not read source files', testFile)
    assertReports("import vm from 'node:vm'\nexport { vm }\n", 'not compile or evaluate', testFile)
    assertReports('export const load = (ts, text) => ts.transpileModule(text, {})\n', 'not compile or evaluate', testFile)
  })

  it('allows fixture paths, module mocks and titles that mention files', () => {
    assertClean("export const target = join(root, 'src/app.ts')\n", testFile)
    assertClean("vi.mock('../src/engine.ts')\n", testFile)
  })

  it('reports SQL text matching and casts to private members', () => {
    assertReports("export const hit = (sql) => sql.startsWith('select * from runs')\n", 'SQL text', testFile)
    assertReports("export const hit = (sql) => sql === 'delete from runs'\n", 'SQL text', testFile)
    assertReports("export function reply(sql) {\n  switch (sql) {\n    case 'update runs set x = 1': return 1\n  }\n}\n",
      'SQL text', testFile)
    assertReports('export const sent = (q) => q.match(/^insert into runs/)\n', 'SQL text', testFile)
    assertReports('export const peek = (service) => (service as unknown as { managers: number }).managers\n',
      'public interface', testFile)
    assertReports('export const peek = (service) => (service as any).managers\n', 'public interface', testFile)
  })

  it('allows tests to query a real database', () => {
    assertClean("export const seed = (pool) => pool.query('insert into runs values (1)')\n", testFile)
  })
})

describe('tests that cannot fail', () => {
  const vitestFile = 'test/engine.test.ts'
  const nodeTestFile = 'test/engine.test.mjs'

  it('reports skipped, deferred and focused tests', () => {
    assertReports("it.skip('runs', () => {\n  expect(run()).toBe(1)\n})\n", 'Do not skip', vitestFile)
    assertReports("it.only('runs', () => {\n  expect(run()).toBe(1)\n})\n", 'Do not skip', vitestFile)
    assertReports("it.todo('runs')\n", 'Do not skip', vitestFile)
    assertReports("import { test } from 'node:test'\ntest('runs', { skip: true }, () => {\n  assert.equal(run(), 1)\n})\n",
      'Do not skip', nodeTestFile)
  })

  it('leaves conditional skips to the CI skipped-test check', () => {
    assertClean("import { test } from 'node:test'\ntest('runs', { skip: !artifact }, () => {\n  assert.equal(run(), 1)\n})\n",
      nodeTestFile)
  })

  it('reports tests without assertions or with vacuous assertions', () => {
    assertReports("it('runs', () => {\n  run()\n})\n", 'Test has no assertions', vitestFile)
    assertReports("it('runs', () => {\n  expect(1).toBe(1)\n})\n", 'Do not compare two constants', vitestFile)
    assertReports("it('fails', () => {\n  expect(() => run()).toThrow()\n})\n", 'error message', vitestFile)
    assertReports("it('fails', () => {\n  assert.throws(() => run())\n})\n", 'which error is thrown', vitestFile)
    assertReports("it('runs', async () => {\n  try {\n    await run()\n  } catch (error) {\n    expect(error).toBe(1)\n  }\n})\n",
      'inside conditional', vitestFile)
  })

  it('accepts focused assertions', () => {
    assertClean("it('shows the run', async () => {\n  await screen.findByText('Run 1')\n})\n", vitestFile)
    assertClean("it('fails', () => {\n  expect(() => run()).toThrow('Run is closed')\n})\n", vitestFile)
    assertClean("it('fails', () => {\n  assert.throws(() => run(), /closed/)\n})\n", vitestFile)
    assertClean("it('runs', () => {\n  expect(run(), 'run result').toBe(2)\n})\n", vitestFile)
  })

  it('reports test files that no runner discovers', () => {
    assertReports('export const ready = true\n', 'not discovered by any test runner', 'test/board.smoke.mjs')
    assertClean('export const ready = true\n', 'test/board.helpers.mjs')
  })
})
