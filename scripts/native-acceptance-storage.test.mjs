import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withNativeAcceptanceStorage } from './native-acceptance-storage.mjs'

async function fixture(execute) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-code-storage-test-'))
  const codex = join(root, 'source-codex')
  const config = join(root, 'source-config')
  const data = join(root, 'source-data', 'opencode')
  await Promise.all([codex, config, data].map(path => mkdir(path, { recursive: true })))
  const source = { HOME: root, TMPDIR: root, CODEX_HOME: codex, OPENCODE_CONFIG_DIR: config,
    XDG_DATA_HOME: join(root, 'source-data'), OPENCODE_DB: join(data, 'original.db') }
  try {
    await writeFile(join(codex, 'auth.json'), 'codex-fixture-credential')
    await writeFile(join(codex, 'config.toml'), 'model = "fixture-model"')
    await writeFile(join(codex, 'models_cache.json'), '{"models":[]}')
    await writeFile(join(codex, 'history.jsonl'), 'original-history')
    await writeFile(join(config, 'opencode.json'), '{"model":"fixture/model"}')
    await writeFile(join(data, 'auth.json'), 'opencode-fixture-credential')
    await writeFile(source.OPENCODE_DB, 'original-database')
    await execute(source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('native subprocesses keep configuration and credentials but write disposable histories', async () => {
  await fixture(async source => {
    let owned
    const result = await withNativeAcceptanceStorage(source, async environment => {
      owned = environment
      assert.equal(await readFile(join(environment.CODEX_HOME, 'auth.json'), 'utf8'), 'codex-fixture-credential')
      assert.equal(await readFile(join(environment.CODEX_HOME, 'config.toml'), 'utf8'), 'model = "fixture-model"')
      assert.equal(await readFile(join(environment.OPENCODE_CONFIG_DIR, 'opencode.json'), 'utf8'), '{"model":"fixture/model"}')
      assert.equal(await readFile(join(environment.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8'), 'opencode-fixture-credential')
      assert.equal((await stat(join(environment.CODEX_HOME, 'auth.json'))).mode & 0o777, 0o600)
      await assert.rejects(access(join(environment.CODEX_HOME, 'history.jsonl')), { code: 'ENOENT' })
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        writeFileSync(join(process.env.CODEX_HOME, 'history.jsonl'), 'new-history');
        writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'refreshed');
        writeFileSync(process.env.OPENCODE_DB, 'new-database');
        writeFileSync(join(process.env.TMPDIR, 'scratch'), 'scratch');
      `], { env: environment, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(await readFile(environment.OPENCODE_DB, 'utf8'), 'new-database')
      return 'completed'
    })
    assert.equal(result, 'completed')
    for (const name of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
      await assert.rejects(access(owned[name]), { code: 'ENOENT' })
    }
    assert.equal(await readFile(join(source.CODEX_HOME, 'history.jsonl'), 'utf8'), 'original-history')
    assert.equal(await readFile(join(source.CODEX_HOME, 'auth.json'), 'utf8'), 'codex-fixture-credential')
    assert.equal(await readFile(source.OPENCODE_DB, 'utf8'), 'original-database')
  })
})

test('failed native operations remove their storage and preserve the original failure', async () => {
  await fixture(async source => {
    const failure = new Error('native-operation-failed')
    let owned
    await assert.rejects(withNativeAcceptanceStorage(source, async environment => {
      owned = environment.CODEX_HOME
      await writeFile(join(owned, 'history.jsonl'), 'failed-history')
      throw failure
    }), error => error === failure)
    await assert.rejects(access(owned), { code: 'ENOENT' })
    assert.equal(await readFile(join(source.CODEX_HOME, 'history.jsonl'), 'utf8'), 'original-history')
  })
})

test('failed configuration copies remove partial storage without running the native operation', async () => {
  await fixture(async source => {
    await symlink(join(source.HOME, 'missing-plugin'), join(source.OPENCODE_CONFIG_DIR, 'plugin'))
    let executed = false
    await assert.rejects(withNativeAcceptanceStorage(source, async () => { executed = true }), { code: 'ENOENT' })
    assert.equal(executed, false)
    assert.deepEqual((await readdir(source.TMPDIR)).filter(name => name.startsWith('foreman-code-native-')), [])
    assert.equal(await readFile(join(source.CODEX_HOME, 'auth.json'), 'utf8'), 'codex-fixture-credential')
  })
})
