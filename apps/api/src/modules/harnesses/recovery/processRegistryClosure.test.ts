import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { privateFixtureDirectory } from '../../../../test/helpers/privateFixtureDirectory.js'
import { NativeProcessRegistry } from './processRegistry.js'
import { bootIdentity, processIdentity } from './linuxIdentity.js'
import { privateDirectory, writeRecord } from './storage.js'

const kernel = vi.hoisted(() => ({ populated: false, killed: vi.fn(), retired: vi.fn() }))
vi.mock('./cgroupBoundary.js', async original => ({
  ...await original<typeof import('./cgroupBoundary.js')>(),
  cgroupPopulated: () => kernel.populated,
  killCgroup: kernel.killed,
  retireCgroup: kernel.retired,
}))
afterEach(() => { vi.restoreAllMocks(); kernel.populated = false; kernel.killed.mockClear() })

async function fixture() {
  const directory = await privateFixtureDirectory('native-closure-')
  const root = join(directory, 'registry')
  const registry = new NativeProcessRegistry(root)
  const owner = 'execution:stopped-execution'
  const scope = registry.reserveLaunch(owner)
  const ownerDirectory = join(root, createHash('sha256').update(owner).digest('hex'))
  const registration = join(ownerDirectory, scope.launchId!)
  const current = processIdentity(process.pid)!
  // The numeric PID is live, but the recorded generation no longer exists.
  const gone = { ...current, startTicks: '0', group: current.pid, session: current.pid }
  writeRecord(join(registration, 'birth.json'), {
    format: 1, id: scope.launchId, owner, boot: bootIdentity(), guardian: gone,
  })
  writeRecord(join(registration, 'provider.json'), {
    format: 1, id: scope.launchId, owner, boot: bootIdentity(), guardian: gone,
    capture: 'captured', provider: gone,
  })
  return { directory, root, registry, owner, scope, ownerDirectory, registration, gone, current }
}

it('keeps a surviving recorded provider fenced after its guardian disappears', async () => {
  const f = await fixture()
  try {
    writeRecord(join(f.registration, 'provider.json'), {
      format: 1, id: f.scope.launchId, owner: f.owner, boot: bootIdentity(), guardian: f.gone,
      capture: 'captured', provider: f.current,
    })
    await expect(f.registry.closeOwner(f.owner, AbortSignal.timeout(100))).rejects.toThrow()
    expect(f.registry.closedRegistration(f.owner, f.scope.launchId!)).toBeUndefined()
    expect(kernel.killed).not.toHaveBeenCalled()
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

it.each(['boot-changed', 'empty-cgroup'] as const)('confirms %s closure without a PID-only kill', async kind => {
  const f = await fixture()
  const kill = vi.spyOn(process, 'kill')
  try {
    if (kind === 'boot-changed') {
      writeRecord(join(f.registration, 'intent.json'), {
        format: 1, id: f.scope.launchId, owner: f.owner, boot: randomUUID(),
        parent: f.current, controlKey: 'a'.repeat(64),
      })
      // These certificates belong to the same recorded boot.
      rmSync(join(f.registration, 'birth.json'))
      rmSync(join(f.registration, 'provider.json'))
    } else {
      writeRecord(join(f.registration, 'birth.json'), {
        format: 1, id: f.scope.launchId, owner: f.owner, boot: bootIdentity(), guardian: f.gone,
        containment: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${f.scope.launchId}`,
          device: '1', inode: '1' },
      })
    }
    expect(await f.registry.closeOwner(f.owner, AbortSignal.timeout(200))).toBe(true)
    expect(kill).not.toHaveBeenCalled()
    expect(kernel.killed).not.toHaveBeenCalled()
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

it('prunes aged closed owner directories while preserving original closure readback and retries', async () => {
  const directory = await privateFixtureDirectory('native-retirement-')
  const root = privateDirectory(join(directory, 'registry'))
  const observations = Array.from({ length: 12 }, () => ({
    owner: `execution:${randomUUID()}`, launchId: randomUUID(), bootId: bootIdentity(),
    lifecycle: 'closed' as const, closureEvidence: 'native_not_started' as const,
  }))
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  try {
    for (const observation of observations) {
      const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(observation.owner).digest('hex')))
      const closed = join(ownerDirectory, `closed-${observation.launchId}.json`)
      const retired = join(ownerDirectory, 'retired.json')
      writeRecord(closed, observation)
      writeRecord(retired, { format: 2, owner: observation.owner, id: observation.launchId, observation })
      utimesSync(closed, old, old)
      utimesSync(retired, old, old)
    }
    const registry = new NativeProcessRegistry(root)
    expect(readdirSync(root).filter(name => /^[0-9a-f]{64}$/.test(name))).toHaveLength(0)
    for (const observation of observations) {
      expect(registry.closedRegistration(observation.owner, observation.launchId)).toEqual(observation)
      expect(await registry.closeOwner(observation.owner)).toBe(true)
      await registry.closeRegistration(registry.scope(observation.owner), observation.launchId)
    }
    expect(registry.snapshot().launches).toEqual(expect.arrayContaining(observations))
    expect(await registry.closeOwner('unknown-owner')).toBe(false)
    expect(existsSync(root)).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
