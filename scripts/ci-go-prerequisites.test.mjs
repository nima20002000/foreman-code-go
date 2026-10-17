import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-go-prerequisites.mjs', import.meta.url))

test('a missing native dependency fails with an actionable build-image instruction', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-native-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [script, 'native'], {
    env: { ...process.env, HOME: directory, TMPDIR: directory, PATH: directory, CC: 'cc', CGO_ENABLED: '1' },
    encoding: 'utf8',
  })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /C compiler, pkg-config and libvips/)
  assert.match(result.stderr, /does not install system packages on build computers/)
})

test('the native prerequisite check accepts available cgo tooling and rejects disabled cgo', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-native-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const name of ['cc', 'pkg-config']) {
    writeFileSync(join(directory, name), `#!${process.execPath}\nconsole.log('fixture compiler or libvips')\n`, { mode: 0o755 })
  }
  const env = { ...process.env, HOME: directory, TMPDIR: directory, PATH: directory, CC: 'cc', CGO_ENABLED: '1' }
  const ready = spawnSync(process.execPath, [script, 'native'], { env, encoding: 'utf8' })
  assert.ifError(ready.error)
  assert.equal(ready.status, 0, ready.stderr)
  const disabled = spawnSync(process.execPath, [script, 'native'], { env: { ...env, CGO_ENABLED: '0' }, encoding: 'utf8' })
  assert.ifError(disabled.error)
  assert.notEqual(disabled.status, 0)
  assert.match(disabled.stderr, /require CGO_ENABLED=1/)
})
