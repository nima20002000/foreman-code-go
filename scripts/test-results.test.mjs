import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { findUnrunTests, readTestResults } from './test-results.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('reading test results', () => {
  it('normalizes Vitest and node:test reports to repository-relative results', () => {
    const directory = mkdtempSync(join(tmpdir(), 'test-results-'))
    try {
      writeFileSync(join(directory, 'vitest-1.json'), JSON.stringify({ testResults: [{
        name: join(root, 'apps/api/test/runs.test.mjs'),
        assertionResults: [
          { fullName: 'runs stops', status: 'passed' },
          { fullName: 'runs persists', status: 'pending' },
          { fullName: 'runs retries', status: 'todo' },
        ],
      }] }))
      writeFileSync(join(directory, 'node-1.json'), JSON.stringify({ runner: 'node', tests: [
        { file: join(root, 'apps/worker/test/cli.test.mjs'), name: 'cli prints help', status: 'failed' },
      ] }))
      assert.deepEqual(readTestResults(directory).sort((a, b) => a.name.localeCompare(b.name)), [
        { file: 'apps/worker/test/cli.test.mjs', name: 'cli prints help', status: 'failed' },
        { file: 'apps/api/test/runs.test.mjs', name: 'runs persists', status: 'skipped' },
        { file: 'apps/api/test/runs.test.mjs', name: 'runs retries', status: 'skipped' },
        { file: 'apps/api/test/runs.test.mjs', name: 'runs stops', status: 'passed' },
      ])
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
})

describe('unrun tests', () => {
  const testFiles = ['a.test.ts', 'b.integration.test.ts', 'live.test.ts']

  it('accepts a test that one run skipped and another executed', () => {
    const results = [
      { file: 'a.test.ts', name: 'saves', status: 'passed' },
      { file: 'b.integration.test.ts', name: 'persists', status: 'skipped' },
      { file: 'b.integration.test.ts', name: 'persists', status: 'passed' },
    ]
    assert.deepEqual(findUnrunTests({ results, testFiles, optInFiles: ['live.test.ts'] }),
      { neverRan: [], missingFiles: [], staleOptIns: [] })
  })

  it('reports tests skipped in every run and files without results', () => {
    const results = [
      { file: 'a.test.ts', name: 'saves', status: 'passed' },
      { file: 'a.test.ts', name: 'retries', status: 'skipped' },
    ]
    assert.deepEqual(findUnrunTests({ results, testFiles, optInFiles: ['live.test.ts'] }),
      { neverRan: ['a.test.ts > retries'], missingFiles: ['b.integration.test.ts'], staleOptIns: [] })
  })

  it('exempts opt-in suites and reports opt-ins for files that no longer exist', () => {
    const results = [
      { file: 'a.test.ts', name: 'saves', status: 'passed' },
      { file: 'b.integration.test.ts', name: 'persists', status: 'passed' },
      { file: 'live.test.ts', name: 'talks to Codex', status: 'skipped' },
    ]
    assert.deepEqual(findUnrunTests({ results, testFiles, optInFiles: ['live.test.ts', 'gone.test.ts'] }),
      { neverRan: [], missingFiles: [], staleOptIns: ['gone.test.ts'] })
  })
})
