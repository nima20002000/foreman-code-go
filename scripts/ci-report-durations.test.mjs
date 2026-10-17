import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { measuredUnitDurations, mergeDurations } from './ci-unit-files.mjs'

test('Go duration extraction accepts measured packages and excludes failures and paths outside the module', () => {
  const result = (name, status, duration) => ({ name, status, duration })
  const report = { testResults: [result('backend', 'passed', 10), result('backend/internal/config', 'passed', 15),
    result('backend/internal/db', 'failed', 30), result('backend-other/pkg', 'passed', 12),
    result('../backend/pkg', 'passed', 12), result('backend/internal/zero', 'passed', 0)] }
  assert.deepEqual(measuredUnitDurations(report, resolve('fixture'), 'go'), { backend: 10, 'backend/internal/config': 15 })
})

test('duration reports merge Go and both conformance targets without duplicate overwrites', () => {
  assert.deepEqual(mergeDurations([{ backend: 10 }, { 'conformance/go/SKEL': 20 }, { 'conformance/ts/SKEL': 30 }]),
    { backend: 10, 'conformance/go/SKEL': 20, 'conformance/ts/SKEL': 30 })
  assert.throws(() => mergeDurations([{ backend: 10 }, { backend: 20 }]), /Duplicate measured duration/)
  for (const report of [null, [], { backend: 0 }, { backend: -1 }, { backend: Infinity }, { backend: 86_400_001 }]) {
    assert.throws(() => mergeDurations([report]), /Invalid/)
  }
})

test('duration merging stays within the existing contract limit', () => {
  const inputs = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`backend/p${index}`, 1]))
  assert.equal(Object.keys(mergeDurations([inputs])).length, 1000)
})

test('the duration CLI merges reports atomically and fails when an expected report is missing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-duration-merge-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = join(directory, 'go.json')
  const second = join(directory, 'conformance.json')
  const output = join(directory, 'durations.json')
  writeFileSync(first, JSON.stringify({ backend: 10 }))
  writeFileSync(second, JSON.stringify({ 'conformance/go/SKEL': 20 }))
  const script = fileURLToPath(new URL('./ci-unit-files.mjs', import.meta.url))
  const env = { ...process.env, HOME: directory, CI_STATE: join(directory, 'state'), CI_PROGRESS_FILE: '' }
  delete env.NODE_TEST_CONTEXT
  const ok = spawnSync(process.execPath, [script, 'merge', output, first, second], { encoding: 'utf8', env })
  assert.ifError(ok.error)
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { backend: 10, 'conformance/go/SKEL': 20 })
  const failed = spawnSync(process.execPath, [script, 'merge', output, first, join(directory, 'missing.json')], { encoding: 'utf8', env })
  assert.ifError(failed.error)
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /missing.json/)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { backend: 10, 'conformance/go/SKEL': 20 })
})
