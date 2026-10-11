import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cachedTestFixture } from './test-fixture-cache.mjs'

async function fixtureCache(t) {
  const root = await mkdtemp(join(tmpdir(), 'test-fixture-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('unchanged inputs reuse complete output and changed inputs populate separately', async t => {
  const root = await fixtureCache(t)
  let builds = 0
  const populate = async directory => {
    builds++
    await writeFile(join(directory, 'payload'), `build ${builds}`)
  }
  const first = await cachedTestFixture(root, 'worker', ['commit', Buffer.from('target')], populate)
  const reused = await cachedTestFixture(root, 'worker', ['commit', Buffer.from('target')], populate)
  const changed = await cachedTestFixture(root, 'worker', ['other-commit', Buffer.from('target')], populate)
  assert.equal(first, reused)
  assert.notEqual(first, changed)
  assert.equal(builds, 2)
  assert.equal(await readFile(join(reused, 'payload'), 'utf8'), 'build 1')
  assert.equal(await readFile(join(changed, 'payload'), 'utf8'), 'build 2')
})

test('failed population releases the lock without publishing partial output', async t => {
  const root = await fixtureCache(t)
  const failure = new Error('fixture build failed')
  await assert.rejects(cachedTestFixture(root, 'worker', ['input'], async directory => {
    await writeFile(join(directory, 'payload'), 'partial')
    throw failure
  }), error => error === failure)
  const complete = await cachedTestFixture(root, 'worker', ['input'], async directory => {
    await writeFile(join(directory, 'payload'), 'complete')
  })
  assert.equal(await readFile(join(complete, 'payload'), 'utf8'), 'complete')
})

function cacheProcess(t, root) {
  const source = `
    import { appendFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { cachedTestFixture } from ${JSON.stringify(new URL('./test-fixture-cache.mjs', import.meta.url).href)};
    const root = process.argv[1];
    const released = new Promise(resolve => process.once('message', resolve));
    process.send({ kind: 'requested' });
    const directory = await cachedTestFixture(root, 'worker', ['shared-input'], async directory => {
      await appendFile(join(root, 'builds'), 'build\\n');
      process.send({ kind: 'building' });
      await released;
      await writeFile(join(directory, 'payload'), 'complete');
    });
    process.send({ kind: 'complete', directory });
    process.disconnect();
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const messages = []
  const waiters = new Map()
  child.on('message', message => {
    messages.push(message)
    waiters.get(message.kind)?.resolve(message)
  })
  const closed = once(child, 'close')
  child.once('close', () => {
    for (const waiter of waiters.values()) waiter.reject(new Error(`Cache process exited: ${stderr}`))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  return {
    child,
    closed,
    message(kind) {
      const found = messages.find(message => message.kind === kind)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => waiters.set(kind, { resolve, reject }))
    },
  }
}

test('independent slots build once and observe only complete output', { timeout: 30_000 }, async t => {
  const root = await fixtureCache(t)
  const first = cacheProcess(t, root)
  await first.message('building')
  const others = Array.from({ length: 3 }, () => cacheProcess(t, root))
  await Promise.all(others.map(process => process.message('requested')))
  first.child.send({ kind: 'release' })
  const processes = [first, ...others]
  const results = await Promise.all(processes.map(process => process.message('complete')))
  const exits = await Promise.all(processes.map(process => process.closed))
  assert.ok(exits.every(([code]) => code === 0))
  assert.equal(new Set(results.map(result => result.directory)).size, 1)
  assert.equal(await readFile(join(root, 'builds'), 'utf8'), 'build\n')
  assert.equal(await readFile(join(results[0].directory, 'payload'), 'utf8'), 'complete')
})

test('an interrupted builder releases its OS lock for the next slot', { timeout: 30_000 }, async t => {
  const root = await fixtureCache(t)
  const interrupted = cacheProcess(t, root)
  await interrupted.message('building')
  interrupted.child.kill('SIGKILL')
  await interrupted.closed
  const complete = await cachedTestFixture(root, 'worker', ['shared-input'], async directory => {
    await appendFile(join(root, 'builds'), 'replacement\n')
    await writeFile(join(directory, 'payload'), 'complete')
  })
  assert.equal(await readFile(join(root, 'builds'), 'utf8'), 'build\nreplacement\n')
  assert.equal(await readFile(join(complete, 'payload'), 'utf8'), 'complete')
})
