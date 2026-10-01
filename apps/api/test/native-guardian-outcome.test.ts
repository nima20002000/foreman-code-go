import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { runCommand, spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'
import { identityAlive, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { NativeProcessRegistry, nativeProcessExit, spawnNativeProcess, stopRecoveredChild } from '../src/modules/harnesses/recovery/processRegistry.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-guardian-outcome-'))
  const registry = new NativeProcessRegistry(root)
  const owner = 'native-outcome-fixture'
  return { root, registry, owner, recovery: registry.reserveLaunch(owner) }
}

describe('exact native outcome through guardian cleanup', () => {
  for (const code of [0, 7]) it(`returns native exit ${code} after confirmed guardian cleanup`, async () => {
    const f = fixture()
    try {
      const result = await runCommand(process.execPath, ['-e', `console.log('native-output');process.exit(${code})`], f.root,
        undefined, undefined, { recovery: f.recovery })
      assert.equal(result.stdout, 'native-output\n')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, code)
      assert.equal(await f.registry.closeOwner(f.owner), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('exposes the native outcome to owned stdio providers while preserving wrapper cleanup facts', async () => {
    const f = fixture()
    const owned = spawnOwnedStdioProcess({ binary: process.execPath, args: ['-e', 'process.exit(0)'],
      cwd: f.root, environment: {}, recovery: f.recovery, onError: () => undefined })
    owned.child.stdout.resume(); owned.child.stderr.resume()
    try {
      assert.deepEqual(await owned.closed, { exitCode: 0, exitSignal: null })
      assert.equal(owned.child.signalCode, 'SIGKILL')
      await owned.close()
      assert.equal(await f.registry.closeOwner(f.owner), true)
    } finally {
      await owned.close()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('preserves native signal failure and missing-executable failure', async () => {
    for (const missing of [false, true]) {
      const f = fixture()
      try {
        const result = await runCommand(missing ? join(f.root, 'missing-native') : process.execPath,
          missing ? [] : ['-e', 'process.kill(process.pid,"SIGTERM")'], f.root,
          undefined, undefined, { recovery: f.recovery })
        assert.equal(result.exitCode, null)
        if (!missing) assert.equal(Reflect.get(result, 'exitSignal'), 'SIGTERM')
        assert.equal(await f.registry.closeOwner(f.owner), true)
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    }
  })

  it('returns the native outcome only after detached descendants are gone', async () => {
    const f = fixture()
    try {
      const result = await runCommand(process.execPath, ['-e', `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
        console.log(child.pid);child.unref();
      `], f.root, undefined, undefined, { recovery: f.recovery })
      const pid = Number(result.stdout.trim())
      assert.ok(Number.isSafeInteger(pid) && pid > 1)
      assert.equal(result.exitCode, 0)
      const descendant = processIdentity(pid)
      assert.ok(!descendant || !identityAlive(descendant))
      assert.equal(await f.registry.closeOwner(f.owner), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('cancellation still rejects after confirmed tree cleanup', async () => {
    const f = fixture()
    try {
      await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], f.root,
        AbortSignal.timeout(250), undefined, { recovery: f.recovery }), { name: 'TimeoutError' })
      assert.equal(await f.registry.closeOwner(f.owner), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  for (const receipt of ['missing', 'stale', 'invalid-outcome'] as const) it(`never promotes ${receipt} receipt into success`, async () => {
    const f = fixture()
    const child = spawnNativeProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: f.root, env: {}, recovery: f.recovery })
    child.stdout.resume(); child.stderr.resume()
    const listeners = child.listeners('message')
    assert.equal(listeners.length, 1)
    child.removeAllListeners('message')
    child.on('message', (message) => {
      if (receipt === 'missing') return
      const row = message as Record<string, unknown>
      Reflect.apply(listeners[0]!, child, [receipt === 'stale' ? { ...row, id: '00000000-0000-0000-0000-000000000000' }
        : { ...row, exitCode: 0, exitSignal: 'SIGKILL' }])
    })
    try {
      const wrapper = await new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }))
      })
      assert.equal(wrapper.exitCode, null)
      assert.equal(wrapper.exitSignal, 'SIGKILL')
      if (receipt === 'missing') {
        assert.deepEqual(nativeProcessExit(child, wrapper), wrapper)
        assert.throws(() => nativeProcessExit(child, { exitCode: 0, exitSignal: null }), /receipt is missing/)
      }
      else assert.throws(() => nativeProcessExit(child, wrapper), /Invalid native exit receipt/)
      assert.equal(await stopRecoveredChild(child), true)
      assert.equal(await f.registry.closeOwner(f.owner), true)
    } finally {
      await stopRecoveredChild(child)
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
