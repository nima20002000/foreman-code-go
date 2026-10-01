import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, opendirSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { cgroupBoundary, type NativeCgroupBoundary } from './cgroupBoundary.js'
import { bootIdentity, identityAlive } from './linuxIdentity.js'
import { readRecord, recordObject } from './storage.js'

export interface NativeLaunchObservation {
  readonly owner: string; readonly launchId: string; readonly bootId: string
  readonly guardian?: Readonly<{ pid: number; startTicks: string }>
  readonly provider?: Readonly<{ pid: number; startTicks: string }>
  /** Internal read certificate only. Never serialize this path to UI/MCP. */
  readonly boundary?: Readonly<NativeCgroupBoundary>
  readonly lifecycle: 'active' | 'ended' | 'closure-unconfirmed' | 'closed'
  readonly closureEvidence?: 'linux_boot_changed' | 'native_not_started' | 'cgroup_v2_empty'
}
export interface NativeRegistrySnapshot { readonly revision: string; readonly launches: readonly NativeLaunchObservation[] }
export interface NativeRegistryChange extends NativeRegistrySnapshot { readonly gap: boolean }

/** Validate existing directories without mkdir, fsync, inventory, or recovery. */
function directory(path: string): boolean {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe native observation directory.')
  }
  const stat = lstatSync(absolute)
  if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Nonprivate native observation directory.')
  return true
}
function* entries(path: string): Iterable<string> {
  const handle = opendirSync(path)
  try {
    let count = 0
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++count > 10_000) throw new Error('limit-exceeded')
      yield entry.name
    }
  } finally { handle.closeSync() }
}
function identity(value: unknown): Readonly<{ pid: number; startTicks: string }> {
  const row = recordObject(value)
  if (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 1 || typeof row.startTicks !== 'string' || !/^\d+$/.test(row.startTicks)) throw new Error('Invalid native observation identity.')
  return Object.freeze({ pid: Number(row.pid), startTicks: row.startTicks })
}
function receipt(value: unknown, launch: NativeLaunchObservation): Record<string, unknown> {
  const row = recordObject(value)
  if (row.format !== 1 || row.id !== launch.launchId || row.owner !== launch.owner || row.boot !== launch.bootId) throw new Error('Native observation receipt mismatch.')
  return row
}

/** Bounded, ephemeral derived projection. Durable ownership remains the registry. */
class Projection {
  private epoch = randomUUID()
  private sequence = 0
  private rows = new Map<string, NativeLaunchObservation>()
  private readonly waiters = new Set<() => void>()
  revision(): string { return this.current.revision }
  private current: NativeRegistrySnapshot = Object.freeze({ revision: `${this.epoch}:0`, launches: Object.freeze([]) })
  constructor(private readonly root: string) {}
  snapshot(): NativeRegistrySnapshot {
    const next = new Map(this.rows)
    const seen = new Set<string>()
    let scanned = 0
    if (directory(this.root)) for (const ownerKey of entries(this.root)) {
      if (!/^[0-9a-f]{64}$/.test(ownerKey)) throw new Error('Unexpected native owner inventory entry.')
      const ownerDirectory = join(this.root, ownerKey)
      if (!directory(ownerDirectory)) continue
      for (const id of entries(ownerDirectory)) {
        if (++scanned > 10_000) throw new Error('limit-exceeded')
        if (!/^[0-9a-f-]{36}$/.test(id)) continue
        const path = join(ownerDirectory, id)
        if (!directory(path)) continue
        const raw = readRecord(join(path, 'intent.json'))
        if (raw === undefined) continue // Concurrent retirement is not closure proof.
        const intent = recordObject(raw)
        if (intent.format !== 1 || intent.id !== id || typeof intent.owner !== 'string' || typeof intent.boot !== 'string'
          || createHash('sha256').update(intent.owner).digest('hex') !== ownerKey) throw new Error('Invalid native observation intent.')
        const launch: NativeLaunchObservation = { owner: intent.owner, launchId: id, bootId: intent.boot, lifecycle: 'closure-unconfirmed' }
        const dispatch = readRecord(join(path, 'dispatched.json'))
        if (dispatch !== undefined) {
          const row = recordObject(dispatch)
          if (row.format !== 1 || row.id !== id) throw new Error('Invalid native observation dispatch.')
          Object.assign(launch, { guardian: identity(row.guardian) })
        }
        const birth = readRecord(join(path, 'birth.json'))
        if (birth !== undefined) {
          const row = receipt(birth, launch)
          Object.assign(launch, { guardian: identity(row.guardian), lifecycle: 'active' })
          if (row.containment !== undefined) {
            const boundary = cgroupBoundary(row.containment, id)
            Object.assign(launch, { boundary: Object.freeze({ kind: boundary.kind, path: boundary.path, device: boundary.device, inode: boundary.inode }) })
          }
        }
        const provider = readRecord(join(path, 'provider.json'))
        if (provider !== undefined) {
          const row = receipt(provider, launch)
          const guardian = identity(row.guardian)
          if (!launch.guardian || guardian.pid !== launch.guardian.pid || guardian.startTicks !== launch.guardian.startTicks) throw new Error('Native provider guardian mismatch.')
          if (row.capture === 'captured') Object.assign(launch, { provider: identity(row.provider) })
          else if (row.capture !== 'unavailable' || row.provider !== undefined) throw new Error('Invalid provider capture.')
        }
        const exit = readRecord(join(path, 'provider-exit.json'))
        if (exit !== undefined) {
          const row = receipt(exit, launch)
          if (row.provider !== undefined) {
            const ended = identity(row.provider)
            if (!launch.provider || ended.pid !== launch.provider.pid || ended.startTicks !== launch.provider.startTicks) throw new Error('Native provider exit mismatch.')
          } else if (launch.provider) throw new Error('Native provider exit identity missing.')
          if (!((Number.isInteger(row.code) && row.signal === null) || (row.code === null && typeof row.signal === 'string'))) throw new Error('Invalid provider exit receipt.')
          Object.assign(launch, { lifecycle: 'ended' })
        }
        if (launch.lifecycle === 'active' && (launch.bootId !== bootIdentity() || !launch.guardian || !identityAlive(launch.guardian))) Object.assign(launch, { lifecycle: 'closure-unconfirmed' })
        const closed = readRecord(join(path, 'closed.json'))
        if (closed !== undefined) {
          const row = recordObject(closed)
          if (row.id !== id || row.owner !== launch.owner) throw new Error('Native observation closure owner mismatch.')
          if (row.format !== 1) {
            if (row.format !== 2 || row.boot !== launch.bootId || !['linux_boot_changed', 'native_not_started', 'cgroup_v2_empty'].includes(String(row.evidence))) throw new Error('Invalid native observation closure evidence.')
            Object.assign(launch, { lifecycle: 'closed', closureEvidence: row.evidence })
          }
        }
        seen.add(id)
        next.set(id, Object.freeze(launch))
      }
    }
    // Missing registrations never turn into closed rows. Preserve observed generations.
    for (const [id, row] of next) if (!seen.has(id) && row.lifecycle === 'active') next.set(id, Object.freeze({ ...row, lifecycle: 'closure-unconfirmed' }))
    let truncated = false
    for (const [id, row] of next) {
      if (next.size <= 10_000) break
      if (row.lifecycle === 'closed') { next.delete(id); truncated = true }
    }
    if (next.size > 10_000) throw new Error('limit-exceeded')
    // Closed projection eviction changes the revision generation; old readers
    // must resnapshot rather than treat cache retention as authoritative history.
    if (truncated) { this.epoch = randomUUID(); this.sequence = 0 }
    const launches = Object.freeze([...next.values()].sort((a, b) => a.launchId.localeCompare(b.launchId)))
    if (JSON.stringify(launches) !== JSON.stringify(this.current.launches)) {
      this.rows = next
      this.current = Object.freeze({ revision: `${this.epoch}:${++this.sequence}`, launches })
      for (const wake of this.waiters) wake()
    }
    return this.current
  }
  async *changes(afterRevision: string, signal: AbortSignal): AsyncIterable<NativeRegistryChange> {
    let after = afterRevision
    while (!signal.aborted) {
      let wake: () => void = () => undefined
      const pending = new Promise<void>(resolve => { wake = resolve })
      // Install before reading the current revision. Publication and this check
      // are synchronous, so there is no subscribe/snapshot race or polling loop.
      this.waiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      try {
        const snapshot = this.current
        if (after !== snapshot.revision) {
          const previous = `${this.epoch}:${this.sequence - 1}`
          const gap = after !== previous
          after = snapshot.revision
          yield Object.freeze({ ...snapshot, gap })
        } else await pending
      } finally { this.waiters.delete(wake); signal.removeEventListener('abort', wake) }
    }
  }
}
const projections = new Map<string, Projection>()
export function nativeRegistryProjection(root: string): Projection {
  const path = resolve(root)
  let projection = projections.get(path)
  if (!projection) { projection = new Projection(path); projections.set(path, projection) }
  return projection
}
