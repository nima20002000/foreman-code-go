import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { bootIdentity, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { privateDirectory, readRecord, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

const io = vi.hoisted(() => ({ reads: 0, inventories: 0, metadata: 0 }))
const races = vi.hoisted(() => ({
  beforeWatch: undefined as (() => void) | undefined,
  beforeOpen: undefined as (() => void) | undefined,
  beforeRead: undefined as ((path: string) => void) | undefined,
  watchers: [] as import('node:fs').FSWatcher[],
}))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: new Proxy(actual.readFileSync, { apply(read, receiver, args) {
      io.reads++
      return Reflect.apply(read, receiver, args)
    } }),
    opendirSync: new Proxy(actual.opendirSync, { apply(open, receiver, args) {
      io.inventories++
      const beforeOpen = races.beforeOpen
      races.beforeOpen = undefined
      beforeOpen?.()
      return Reflect.apply(open, receiver, args)
    } }),
    readdirSync: new Proxy(actual.readdirSync, { apply(read, receiver, args) {
      races.beforeRead?.(String(args[0]))
      return Reflect.apply(read, receiver, args)
    } }),
    watch: new Proxy(actual.watch, { apply(watch, receiver, args) {
      const beforeWatch = races.beforeWatch
      races.beforeWatch = undefined
      beforeWatch?.()
      const watcher = Reflect.apply(watch, receiver, args)
      races.watchers.push(watcher)
      return watcher
    } }),
    lstatSync: new Proxy(actual.lstatSync, { apply(stat, receiver, args) {
      io.metadata++
      return Reflect.apply(stat, receiver, args)
    } }),
  }
})

afterEach(() => {
  races.beforeWatch = undefined
  races.beforeOpen = undefined
  races.beforeRead = undefined
  for (const watcher of races.watchers.splice(0)) watcher.close()
})

const dayMs = 24 * 60 * 60 * 1000
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-registry-index-'))
  const owner = 'execution:registry-fixture'
  const directory = privateDirectory(join(root, createHash('sha256').update(owner).digest('hex')))
  const boot = bootIdentity()
  function receipt(id = randomUUID(), receiptOwner = owner) {
    const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(receiptOwner).digest('hex')))
    const observation = { owner: receiptOwner, launchId: id, bootId: boot, lifecycle: 'closed' as const,
      closureEvidence: 'native_not_started' as const }
    const path = join(ownerDirectory, `closed-${id}.json`)
    writeFileSync(path, JSON.stringify(observation), { mode: 0o600 })
    writeFileSync(join(ownerDirectory, 'retired.json'), JSON.stringify({
      format: 2, owner: receiptOwner, id, observation,
    }), { mode: 0o600 })
    return { id, path, observation, ownerDirectory }
  }
  function registration(options: { closed?: true; live?: true } = {}) {
    const id = randomUUID()
    const path = privateDirectory(join(directory, id))
    const intent = { format: 1, id, owner, boot, parent: processIdentity(process.pid), controlKey: 'a'.repeat(64) }
    writeRecord(join(path, 'intent.json'), intent)
    if (options.live) writeRecord(join(path, 'birth.json'), { ...intent, guardian: processIdentity(process.pid) })
    if (options.closed) {
      writeRecord(join(path, 'closed.json'), { format: 2, id, owner, boot, evidence: 'native_not_started' })
      age(join(path, 'closed.json'))
    }
    return { id, path, intent }
  }
  return { root, owner, directory, receipt, registration }
}
function age(path: string, elapsed = 2 * dayMs): void {
  const time = new Date(Date.now() - elapsed)
  utimesSync(path, time, time)
}

describe('incremental native registry', () => {
  it('rescans persisted launches when a directory disappears during watcher startup', () => {
    const f = fixture()
    try {
      const row = f.registration({ live: true })
      const registry = new NativeProcessRegistry(f.root)
      races.beforeWatch = () => {
        throw Object.assign(new Error('registry directory disappeared'), { code: 'ENOENT' })
      }
      const snapshot = registry.snapshot()
      expect(snapshot.launches).toContainEqual(expect.objectContaining({
        launchId: row.id, lifecycle: 'active',
      }))
      expect(registry.snapshot()).toBe(snapshot)
      expect(readRecord(join(row.path, 'intent.json'))).toEqual(row.intent)
      expect(registry.closedRegistration(f.owner, row.id)).toBeUndefined()
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('rescans after a watcher loses a directory without treating disappearance as closure', async () => {
    const f = fixture()
    try {
      const row = f.registration({ live: true })
      const registry = new NativeProcessRegistry(f.root)
      expect(registry.snapshot().launches[0]?.lifecycle).toBe('active')
      rmSync(row.path, { recursive: true })
      races.watchers.at(-1)!.emit('error', Object.assign(new Error('retired directory disappeared'), {
        code: 'ENOENT',
      }))
      expect(registry.snapshot().launches).toContainEqual(expect.objectContaining({
        launchId: row.id, lifecycle: 'closure-unconfirmed',
      }))
      expect(registry.closedRegistration(f.owner, row.id)).toBeUndefined()
      await expect(registry.closeRegistration(registry.scope(f.owner), row.id))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['root', 'owner'] as const)('tolerates a missing %s between validation and scanning', level => {
    const f = fixture()
    try {
      const row = f.registration({ live: true })
      const registry = new NativeProcessRegistry(f.root)
      expect(registry.snapshot().launches[0]?.lifecycle).toBe('active')
      const directory = level === 'root' ? f.root : f.directory
      privateDirectory(join(directory, level === 'root' ? 'b'.repeat(64) : randomUUID()))
      races.beforeOpen = () => rmSync(directory, { recursive: true })
      const snapshot = registry.snapshot()
      expect(snapshot.launches).toContainEqual(expect.objectContaining({
        launchId: row.id, lifecycle: 'closure-unconfirmed',
      }))
      expect(registry.closedRegistration(f.owner, row.id)).toBeUndefined()
      expect(registry.snapshot()).toBe(snapshot)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['root', 'owner'] as const)('does not recreate a %s removed during startup maintenance', async level => {
    const f = fixture()
    try {
      const row = f.registration({ live: true })
      const directory = level === 'root' ? f.root : f.directory
      races.beforeRead = path => {
        if (path !== directory) return
        races.beforeRead = undefined
        rmSync(directory, { recursive: true })
      }
      const registry = new NativeProcessRegistry(f.root)
      expect(registry.snapshot().launches).toEqual([])
      expect(existsSync(directory)).toBe(false)
      expect(registry.closedRegistration(f.owner, row.id)).toBeUndefined()
      expect(readRecord(join(row.path, 'intent.json'))).toBeUndefined()
      await expect(registry.closeRegistration(registry.scope(f.owner), row.id))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['startup', 'event'] as const)('preserves watcher permission failures during %s', phase => {
    const f = fixture()
    try {
      f.registration()
      const registry = new NativeProcessRegistry(f.root)
      const denied = Object.assign(new Error('registry access denied'), { code: 'EACCES' })
      if (phase === 'startup') races.beforeWatch = () => { throw denied }
      else {
        registry.snapshot()
        races.watchers.at(-1)!.emit('error', denied)
      }
      expect(() => registry.snapshot()).toThrow(denied)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('keeps unchanged snapshot IO constant with a thousand retired owners', () => {
    const costs: typeof io[] = []
    for (const history of [0, 1000]) {
      const f = fixture()
      try {
        for (let index = 0; index < history; index++) f.receipt(randomUUID(), `retired-owner-${index}`)
        const registry = new NativeProcessRegistry(f.root)
        const baseline = registry.snapshot()
        expect(baseline.launches).toHaveLength(history)
        io.reads = 0
        io.inventories = 0
        io.metadata = 0
        for (let capture = 0; capture < 20; capture++) expect(registry.snapshot()).toBe(baseline)
        costs.push({ ...io })
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    }
    expect(costs[1]).toEqual(costs[0])
    expect(costs[1]?.reads).toBe(0)
    expect(costs[1]?.inventories).toBe(0)
  })

  it('prunes an aged retired receipt while preserving closure readback and idempotent retries', async () => {
    const f = fixture()
    try {
      const old = f.receipt()
      age(old.path)
      const registry = new NativeProcessRegistry(f.root)
      expect(readRecord(old.path)).toBeUndefined()
      expect(registry.closedRegistration(f.owner, old.id)).toEqual(old.observation)
      expect(registry.snapshot().launches).toEqual([old.observation])
      await registry.closeRegistration(registry.scope(f.owner), old.id)
      await registry.closeRegistration(registry.scope(f.owner), old.id)
      expect(await registry.closeOwner(f.owner)).toBe(true)
      await expect(registry.closeRegistration(registry.scope(f.owner), randomUUID())).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('retains a recent closure certificate for the recovery window', () => {
    const f = fixture()
    try {
      const recent = f.receipt()
      age(recent.path, dayMs - 60_000)
      const registry = new NativeProcessRegistry(f.root)
      expect(readRecord(recent.path)).toEqual(recent.observation)
      expect(registry.closedRegistration(f.owner, recent.id)).toEqual(recent.observation)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('reclaims an aged confirmed launch and keeps its exact closure for retries', async () => {
    const f = fixture()
    try {
      const row = f.registration({ closed: true })
      const registry = new NativeProcessRegistry(f.root)
      expect(readRecord(join(row.path, 'intent.json'))).toBeUndefined()
      expect(registry.closedRegistration(f.owner, row.id)).toMatchObject({ launchId: row.id, lifecycle: 'closed' })
      await registry.closeRegistration(registry.scope(f.owner), row.id)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('never prunes a live generation or an unconfirmed launch based on age', async () => {
    const f = fixture()
    try {
      const live = f.registration({ closed: true, live: true })
      const unconfirmed = f.registration()
      age(join(unconfirmed.path, 'intent.json'))
      const registry = new NativeProcessRegistry(f.root)
      expect(readRecord(join(live.path, 'intent.json'))).toEqual(live.intent)
      expect(readRecord(join(unconfirmed.path, 'intent.json'))).toEqual(unconfirmed.intent)
      await expect(registry.closeRegistration(registry.scope(f.owner), live.id)).rejects.toThrow('live process')
      await expect(registry.closeRegistration(registry.scope(f.owner), unconfirmed.id, AbortSignal.timeout(25)))
        .rejects.toThrow()
      expect(readRecord(join(live.path, 'intent.json'))).toEqual(live.intent)
      expect(readRecord(join(unconfirmed.path, 'intent.json'))).toEqual(unconfirmed.intent)
      expect(() => registry.reserveLaunch(f.owner)).toThrow('live process')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('retains an aged closed receipt if its recorded process still lives', () => {
    const f = fixture()
    try {
      const row = f.receipt()
      const current = processIdentity(process.pid)!
      const observation = { ...row.observation, guardian: { pid: current.pid, startTicks: current.startTicks } }
      writeRecord(row.path, observation)
      writeRecord(join(f.directory, 'retired.json'), { format: 2, owner: f.owner, id: row.id, observation })
      age(row.path)
      const registry = new NativeProcessRegistry(f.root)
      expect(readRecord(row.path)).toEqual(observation)
      expect(registry.closedRegistration(f.owner, row.id)).toEqual(observation)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('keeps an aged legacy close marker unconfirmed and blocks owner reuse', () => {
    const f = fixture()
    try {
      const row = f.registration({ closed: true })
      writeRecord(join(row.path, 'closed.json'), { format: 1, id: row.id, owner: f.owner })
      age(join(row.path, 'closed.json'))
      const registry = new NativeProcessRegistry(f.root)
      expect(registry.snapshot().launches[0]?.lifecycle).toBe('closure-unconfirmed')
      expect(readRecord(join(row.path, 'intent.json'))).toEqual(row.intent)
      expect(() => registry.reserveLaunch(f.owner)).toThrow('active or unconfirmed')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('observes filesystem publication under a previously retired owner without a local storage write', async () => {
    const f = fixture()
    try {
      f.receipt()
      const registry = new NativeProcessRegistry(f.root)
      const baseline = registry.snapshot()
      const id = randomUUID()
      const path = privateDirectory(join(f.directory, id))
      const boot = bootIdentity()
      writeFileSync(join(path, 'intent.json'), JSON.stringify({
        format: 1, id, owner: f.owner, boot, parent: processIdentity(process.pid), controlKey: 'a'.repeat(64),
      }), { mode: 0o600 })
      await vi.waitFor(() => {
        const changed = registry.snapshot()
        expect(changed.launches).toContainEqual({ owner: f.owner, launchId: id, bootId: boot,
          lifecycle: 'closure-unconfirmed' })
        expect(changed.revision).not.toBe(baseline.revision)
      })
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('recovers an interrupted archive copy without losing closure or replacing a conflicting certificate', () => {
    for (const conflict of [false, true]) {
      const f = fixture()
      try {
        const row = f.receipt()
        age(row.path)
        const archive = privateDirectory(join(f.directory, 'closed'))
        writeRecord(join(archive, `${row.id}.json`), conflict
          ? { ...row.observation, bootId: 'different-boot' } : row.observation)
        if (conflict) {
          expect(() => new NativeProcessRegistry(f.root)).toThrow('Conflicting archived native closure')
          expect(readRecord(row.path)).toEqual(row.observation)
        } else {
          const registry = new NativeProcessRegistry(f.root)
          expect(readRecord(row.path)).toBeUndefined()
          expect(registry.closedRegistration(f.owner, row.id)).toEqual(row.observation)
        }
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    }
  })

  it('rebuilds live and closed observations from persisted records with a fresh process index', async () => {
    const f = fixture()
    try {
      const old = f.receipt()
      age(old.path)
      const registry = new NativeProcessRegistry(f.root)
      const scope = registry.reserveLaunch('execution:remaining-launch')
      const before = registry.snapshot()
      vi.resetModules()
      const { NativeProcessRegistry: RestartedRegistry } = await import('../src/modules/harnesses/recovery/processRegistry.js')
      const restarted = new RestartedRegistry(f.root)
      const after = restarted.snapshot()
      expect(after.revision).not.toBe(before.revision)
      expect(after.launches).toEqual(before.launches)
      expect(after.launches.find(row => row.launchId === scope.launchId)?.lifecycle).toBe('closure-unconfirmed')
      expect(restarted.closedRegistration(f.owner, old.id)).toEqual(old.observation)
      expect(restarted.snapshot()).toBe(after)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
