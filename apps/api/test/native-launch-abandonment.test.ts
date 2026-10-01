import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { NativeProcessRegistry, spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { readRecord, recordObject, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-launch-abandonment-'))
  const registry = new NativeProcessRegistry(root)
  const scope = registry.reserveLaunch('diagnostic-fixture-owner')
  const ownerDirectory = join(root, createHash('sha256').update(scope.owner).digest('hex'))
  const directory = join(ownerDirectory, scope.launchId!)
  return { root, registry, scope, ownerDirectory, directory }
}

describe('original-parent no-dispatch retirement', () => {
  it('publishes positive no-start evidence and permanently fences the exact abandoned scope', async () => {
    const f = fixture()
    try {
      // A live parent and undispatched intent alone remain insufficient evidence.
      await assert.rejects(f.registry.closeRegistration(f.scope, f.scope.launchId!, AbortSignal.timeout(75)))
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
      assert.equal(await f.registry.closeOwner(f.scope.owner), true)
      assert.deepEqual(readdirSync(f.ownerDirectory), ['retired.json'])
      assert.throws(() => spawnNativeProcess(process.execPath, ['-e', 'throw new Error("must never launch")'], {
        cwd: f.root, env: {}, recovery: f.scope,
      }))
      assert.throws(() => spawnNativeProcess(process.execPath, ['-e', 'throw new Error("must never launch")'], {
        cwd: f.root, env: {}, recovery: { ...f.scope },
      }))
      assert.deepEqual(readdirSync(f.ownerDirectory), ['retired.json'])
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  for (const state of ['claimed.json', 'dispatched.json', 'birth.json', 'containment.json', 'closed.json']) {
    it(`refuses abandonment after ${state} without publishing no-start evidence`, async () => {
      const f = fixture()
      try {
        // Private markers model an already-entered lifecycle; no fixture process runs.
        writeRecord(join(f.directory, state), { id: f.scope.launchId, owner: f.scope.owner })
        assert.equal(await f.registry.abandonReservedLaunch(f.scope), false)
        assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
        assert.ok(readRecord(join(f.directory, 'intent.json')))
        rmSync(join(f.directory, state))
        assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    })
  }

  it('rejects foreign root, owner, and launch scopes without changing the original reservation', async () => {
    const f = fixture()
    try {
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope, root: join(f.root, 'foreign') }))
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope, owner: 'another-owner' }))
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope, launchId: randomUUID() }))
      await assert.rejects(f.registry.abandonReservedLaunch(f.registry.scope(f.scope.owner)))
      assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  for (const field of ['boot', 'parent-pid', 'parent-generation', 'owner', 'id']) it(`rejects stale ${field} binding`, async () => {
    const f = fixture()
    const path = join(f.directory, 'intent.json')
    const original = recordObject(readRecord(path))
    try {
      const changed = structuredClone(original)
      if (field === 'boot') changed.boot = 'earlier-boot'
      else if (field === 'owner') changed.owner = 'another-owner'
      else if (field === 'id') changed.id = randomUUID()
      else {
        const parent = recordObject(changed.parent)
        if (field === 'parent-pid') parent.pid = Number(parent.pid) + 1
        else parent.startTicks = String(BigInt(String(parent.startTicks)) + 1n)
      }
      writeRecord(path, changed)
      await assert.rejects(f.registry.abandonReservedLaunch(f.scope), /exact original parent/)
      assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
      writeRecord(path, original)
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
