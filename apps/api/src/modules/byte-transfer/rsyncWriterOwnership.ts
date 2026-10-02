import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { FileHandle } from 'node:fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { BYTE_TRANSFER_POLICY as POLICY, TransferIntentSchema, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { bootIdentity, identityAlive, processIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { cgroupPopulated } from '../harnesses/recovery/cgroupBoundary.js'
import { NativeProcessRegistry, spawnNativeProcess, nativeProcessExit,
  type NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, readRecord, writeRecord } from '../harnesses/recovery/storage.js'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Identity = z.object({ pid: z.number().int().min(2), startTicks: z.string().regex(/^\d+$/) }).strict()
const Root = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
const Binary = z.object({ executable: z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/), sha256: Hash, commandDigest: Hash.optional() }).strict()
const Owner = z.object({ version: z.literal(1), ownerId: z.uuid(), intent: TransferIntentSchema,
  binding: DeviceSessionBindingSchema, hostBootId: z.uuid(), issuer: Identity, root: Root,
  role: z.enum(['rsync-client', 'rsync-server', 'snapshot', 'receiver', 'source-materializer']), binary: Binary.optional() }).strict()
const Reference = z.object({ transferId: z.uuid(), ownerId: z.uuid(), ownerDigest: Hash }).strict()
const Claim = Reference.extend({ version: z.literal(1), mode: z.enum(['cancelled', 'process']),
  hostBootId: z.uuid(), parent: Identity }).strict()
const Launch = Reference.extend({ version: z.literal(1), launchId: z.uuid() }).strict()
const Closed = Reference.extend({ version: z.literal(1), evidence: z.enum(['access-drained', 'access-process-gone',
  'host-boot-changed', 'never-dispatched', 'rsync-process-closed']), launchId: z.uuid().optional() }).strict()
const Lock = Reference.extend({ version: z.literal(1), root: Root, lock: Root }).strict()
export type RsyncOwnerReference = z.infer<typeof Reference>
export interface RsyncProcessLaunch extends RsyncOwnerReference { ownership: RsyncWriterOwnership }
export interface RsyncRemoteWriter extends RsyncOwnerReference { nodeBinary: string; entryPoint: string }
export interface RsyncAccessLease {
  readonly reference: RsyncOwnerReference
  run<T>(work: () => Promise<T>): Promise<T>
  attach(handle: FileHandle): void
  captureLock(): void
  close(): Promise<void>
}
export interface RsyncStoreOwnership {
  access(intent: TransferIntent, role: 'snapshot' | 'receiver'): RsyncAccessLease
  processesQuiescent(intent: TransferIntent, signal: AbortSignal, requireProcess?: boolean): Promise<void>
  quiescent(intent: TransferIntent, signal: AbortSignal): Promise<void>
  assertLock(intent: TransferIntent): void
  retire<T>(intent: TransferIntent, work: () => Promise<T>): Promise<T>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const self = () => {
  const found = processIdentity(process.pid)
  if (!found) throw new Error('Rsync owner process identity unavailable')
  return Identity.parse({ pid: found.pid, startTicks: found.startTicks })
}
const certificate = (path: string) => {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077n) || stat.uid !== BigInt(process.getuid!())) throw new Error('Unsafe rsync ownership directory')
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

/** Metadata only, under the installed private staging root. Quota remains the existing supervisor.
 * A new generic kernel registration is created for THIS actual rsync process tree; an unrelated
 * native Job/container close is never accepted as byte-writer closure. No timer or recovery spawn. */
export class RsyncWriterOwnership {
  private readonly root: string
  private readonly journal: string
  private readonly rootIdentity: z.infer<typeof Root>
  private readonly processes: NativeProcessRegistry
  private readonly accesses = new Map<string, RsyncAccessLease>()
  private draining = false
  constructor(root: string, private readonly current: (deviceId: string) => Readonly<DeviceSessionBinding> | undefined) {
    if (process.platform !== 'linux') throw new Error('Rsync writer ownership requires Linux')
    this.root = privateDirectory(resolve(root)); this.rootIdentity = certificate(this.root)
    this.journal = privateDirectory(join(this.root, '.rsync-writers'))
    this.processes = new NativeProcessRegistry(join(this.journal, '.processes'))
  }
  private directory(intent: TransferIntent) { return join(this.journal, intent.transferId) }
  private pin() {
    if (!isDeepStrictEqual(certificate(this.root), this.rootIdentity)) throw new Error('Rsync ownership root changed')
    privateDirectory(this.root); privateDirectory(this.journal)
  }
  private original(input: TransferIntent): TransferIntent {
    this.pin()
    const i = TransferIntentSchema.parse(input), raw = readRecord(join(this.directory(i), 'intent.json'))
    if (!raw || !isDeepStrictEqual(TransferIntentSchema.parse(raw), i)) throw new Error('Original rsync owner intent unavailable or changed')
    privateDirectory(this.directory(i))
    return i
  }
  private admissible(i: TransferIntent) {
    if (this.draining || Date.now() >= Date.parse(i.expiresAt) || Date.parse(i.expiresAt) - Date.now() > POLICY.maxLifetimeMs
      || readRecord(join(this.directory(i), 'retiring.json')) !== undefined) throw new Error('Rsync writer admission is closed')
  }
  private binding(i: TransferIntent, input: Readonly<DeviceSessionBinding>) {
    const b = DeviceSessionBindingSchema.parse(input)
    if (!isDeepStrictEqual(this.current(i.deviceId), b)) throw new Error('Rsync writer binding is not current')
    for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (b[key] !== i[key]) throw new Error('Rsync writer principal differs from original transfer')
    }
    return b
  }
  private read(reference: RsyncOwnerReference) {
    this.pin()
    const ref = Reference.parse({ transferId: reference.transferId, ownerId: reference.ownerId, ownerDigest: reference.ownerDigest })
    const directory = join(this.journal, ref.transferId)
    const i = this.original(TransferIntentSchema.parse(readRecord(join(directory, 'intent.json'))))
    const row = Owner.parse(readRecord(join(directory, `${ref.ownerId}.owner`)))
    if (row.ownerId !== ref.ownerId || i.transferId !== ref.transferId || digest(row) !== ref.ownerDigest
      || !isDeepStrictEqual(row.intent, i) || !isDeepStrictEqual(row.root, this.rootIdentity)) throw new Error('Rsync owner identity conflicts')
    return { row, ref, path: join(directory, ref.ownerId) }
  }

  private references(i: TransferIntent): RsyncOwnerReference[] {
    const references: RsyncOwnerReference[] = []
    for (const name of readdirSync(this.directory(i))) {
      if (!name.endsWith('.owner')) continue
      const row = Owner.parse(readRecord(join(this.directory(i), name)))
      if (name !== `${row.ownerId}.owner` || !isDeepStrictEqual(row.intent, i)) throw new Error('Rsync owner inventory conflicts')
      references.push({ transferId: i.transferId, ownerId: row.ownerId, ownerDigest: digest(row) })
      if (references.length > POLICY.maxRecords) throw new Error('Rsync owner inventory exceeds policy')
    }
    return references
  }
  private prepare(input: TransferIntent, binding: Readonly<DeviceSessionBinding>, role: z.infer<typeof Owner>['role'], binary?: z.infer<typeof Binary>) {
    this.pin()
    const i = TransferIntentSchema.parse(input), b = this.binding(i, binding)
    if (this.inventory().length >= POLICY.maxRecords && !readRecord(join(this.directory(i), 'intent.json'))) throw new Error('Rsync owner inventory exceeds policy')
    this.admissible(i)
    const path = join(this.directory(i), 'intent.json'), original = readRecord(path)
    if (original === undefined) {
      if (readdirSync(this.root).some(name => name.startsWith(`${i.transferId}.`))) throw new Error('Unregistered rsync residue retains its original hold')
      privateDirectory(this.directory(i)); writeRecord(path, i, true)
    }
    else this.original(i)
    if (this.references(i).length >= POLICY.maxRecords) throw new Error('Rsync owner history exceeds policy')
    const row = Owner.parse({ version: 1, ownerId: randomUUID(), intent: i, binding: b,
      hostBootId: bootIdentity(), issuer: self(), root: this.rootIdentity, role, ...(binary ? { binary } : {}) })
    writeRecord(join(this.directory(i), `${row.ownerId}.owner`), row, true)
    return { transferId: i.transferId, ownerId: row.ownerId, ownerDigest: digest(row) }
  }
  prepareProcess(i: TransferIntent, binding: Readonly<DeviceSessionBinding>, role: 'rsync-client' | 'rsync-server', binary: z.infer<typeof Binary>): RsyncProcessLaunch {
    this.pin()
    if (role === 'rsync-client' && !binary.commandDigest) throw new Error('Original rsync client command pin unavailable')
    const existing = readRecord(join(this.directory(TransferIntentSchema.parse(i)), 'intent.json'))
    if (existing !== undefined) for (const old of this.references(this.original(i))) {
      const { row, path } = this.read(old)
      if (row.role === role) {
        const closed = readRecord(`${path}.closed`)
        if (closed === undefined) throw new Error('An original rsync process owner is still active or unconfirmed')
        this.assertClosed(old, closed)
      }
    }
    const ref = this.prepare(i, binding, role, Binary.parse(binary))
    this.admissible(i)
    return { ...ref, ownership: this }
  }
  private scope(reference: RsyncOwnerReference, launchId?: string): NativeProcessRecovery {
    return { root: join(this.journal, '.processes'), owner: `rsync:${reference.transferId}:${reference.ownerId}:${reference.ownerDigest}`, ...(launchId ? { launchId } : {}) }
  }
  private assertClosed(reference: RsyncOwnerReference, raw: unknown) {
    const { row, ref, path } = this.read(reference), proof = Closed.parse(raw)
    if (proof.transferId !== ref.transferId || proof.ownerId !== ref.ownerId || proof.ownerDigest !== ref.ownerDigest) throw new Error('Rsync close owner mismatch')
    if (proof.evidence === 'rsync-process-closed') {
      const launch = Launch.parse(readRecord(`${path}.launch`)), scope = this.scope(ref, launch.launchId)
      const retired = readRecord(join(scope.root, digestBytes(Buffer.from(scope.owner)), 'retired.json')) as Record<string, unknown> | undefined
      if (!row.binary || launch.transferId !== ref.transferId || launch.ownerId !== ref.ownerId || launch.ownerDigest !== ref.ownerDigest
        || proof.launchId !== launch.launchId || retired?.format !== 2 || retired.owner !== scope.owner || retired.id !== launch.launchId) throw new Error('Original rsync process retirement proof unavailable')
    } else if (proof.evidence === 'never-dispatched') {
      const claim = Claim.parse(readRecord(`${path}.claim`))
      if (!row.binary || claim.transferId !== ref.transferId || claim.ownerId !== ref.ownerId || claim.ownerDigest !== ref.ownerDigest
        || (claim.mode !== 'cancelled' && (readRecord(`${path}.launch`) !== undefined
          || (claim.hostBootId === bootIdentity() && identityAlive(claim.parent))))) throw new Error('Original rsync no-dispatch proof unavailable')
    } else if (proof.evidence === 'host-boot-changed') {
      if (row.hostBootId === bootIdentity()) throw new Error('Original rsync boot-change proof unavailable')
    } else if (row.binary) throw new Error('In-process drain cannot close an rsync subprocess')
  }
  private closed(reference: RsyncOwnerReference, evidence: z.infer<typeof Closed>['evidence'], launchId?: string) {
    const { path, ref } = this.read(reference), value = { version: 1 as const, ...ref, evidence, ...(launchId ? { launchId } : {}) }
    const old = readRecord(`${path}.closed`)
    if (old !== undefined) {
      this.assertClosed(ref, old)
      return
    }
    writeRecord(`${path}.closed`, value, true)
  }
  /** Single-use causal handoff. Current binding, pinned binary, exact owner and write-ahead
   * native registration are all checked before sending any executable configuration. */
  spawnProcess(reference: RsyncOwnerReference, executable: string, args: string[], signal: AbortSignal): ChildProcessWithoutNullStreams {
    const { row, path, ref } = this.read(reference)
    signal.throwIfAborted(); this.admissible(row.intent); this.binding(row.intent, row.binding)
    if (row.hostBootId !== bootIdentity() || readRecord(`${path}.closed`) !== undefined) throw new Error('Original rsync process owner is no longer dispatchable')
    if (!row.binary || executable !== row.binary.executable || digestBytes(readFileSync(executable)) !== row.binary.sha256
      || !['rsync-client', 'rsync-server'].includes(row.role)
      || (row.role === 'rsync-client' && row.binary.commandDigest !== rsyncArgumentDigest(args))) throw new Error('Pinned rsync owner binary differs')
    writeRecord(`${path}.claim`, { version: 1, ...ref, mode: 'process', hostBootId: bootIdentity(), parent: self() }, true)
    this.admissible(row.intent)
    const scope = this.processes.reserveLaunch(this.scope(ref).owner)
    writeRecord(`${path}.launch`, { version: 1, ...ref, launchId: scope.launchId }, true)
    // scope belongs to this live launching parent. It is never reconstructed for a replacement spawn.
    return spawnNativeProcess(executable, args, { cwd: this.root, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, recovery: scope })
  }
  spawnServer(reference: RsyncOwnerReference, args: string[], signal: AbortSignal) {
    const { row } = this.read(reference)
    if (row.role !== 'rsync-server' || !row.binary || args[0] !== '--server' || args.includes('--daemon')
      || args.includes('--sender') !== (row.intent.direction === 'to-main') || args.length > 64
      || args.some(value => value.includes('\0') || value.length > 4096)) throw new Error('Invalid admitted rsync server command')
    return this.spawnProcess(reference, row.binary.executable, args, signal)
  }
  async completeProcess(reference: RsyncOwnerReference, signal: AbortSignal) {
    const { path, ref } = this.read(reference), launch = Launch.parse(readRecord(`${path}.launch`))
    if (launch.transferId !== ref.transferId || launch.ownerId !== ref.ownerId || launch.ownerDigest !== ref.ownerDigest) throw new Error('Rsync launch owner mismatch')
    await this.processes.closeRegistration(this.scope(ref, launch.launchId), launch.launchId, signal)
    this.closed(ref, 'rsync-process-closed', launch.launchId)
  }
  private async quiet(reference: RsyncOwnerReference, signal: AbortSignal, stop: boolean) {
    signal.throwIfAborted()
    const { row, ref, path } = this.read(reference), old = readRecord(`${path}.closed`)
    if (old !== undefined) {
      this.assertClosed(ref, old)
      return
    }
    if (row.hostBootId !== bootIdentity()) { this.closed(ref, 'host-boot-changed'); return }
    if (!row.binary) {
      const access = this.accesses.get(ref.ownerId)
      if (stop && access) { await access.close(); return }
      if (!identityAlive(row.issuer)) { this.closed(ref, 'access-process-gone'); return }
      throw new Error('Rsync byte access remains active or unconfirmed')
    }
    let rawClaim = readRecord(`${path}.claim`)
    if (rawClaim === undefined && stop) {
      try { writeRecord(`${path}.claim`, { version: 1, ...ref, mode: 'cancelled', hostBootId: bootIdentity(), parent: self() }, true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      rawClaim = readRecord(`${path}.claim`)
    }
    if (rawClaim === undefined) throw new Error('Rsync server launch is pending or unconfirmed')
    const claim = Claim.parse(rawClaim)
    if (claim.transferId !== ref.transferId || claim.ownerId !== ref.ownerId || claim.ownerDigest !== ref.ownerDigest) throw new Error('Rsync launch claim differs')
    if (claim.mode === 'cancelled') { this.closed(ref, 'never-dispatched'); return }
    const rawLaunch = readRecord(`${path}.launch`)
    if (rawLaunch === undefined) {
      if (claim.hostBootId !== bootIdentity() || !identityAlive(claim.parent)) {
        // Executable dispatch requires launch publication. A dead claim parent cannot cross that gate.
        await this.processes.closeOwner(this.scope(ref).owner, signal)
        this.closed(ref, 'never-dispatched'); return
      }
      throw new Error('Rsync launch handoff remains unconfirmed')
    }
    const launch = Launch.parse(rawLaunch)
    if (launch.transferId !== ref.transferId || launch.ownerId !== ref.ownerId || launch.ownerDigest !== ref.ownerDigest) throw new Error('Rsync launch owner mismatch')
    if (stop && claim.hostBootId === bootIdentity() && isDeepStrictEqual(claim.parent, self())) {
      await this.processes.abandonReservedLaunch(this.scope(ref, launch.launchId))
    }
    if (!stop) {
      const observation = this.processes.snapshot().launches.find(item => item.launchId === launch.launchId)
      const registered = join(this.scope(ref).root, digestBytes(Buffer.from(this.scope(ref).owner)), launch.launchId)
      const rawIntent = readRecord(join(registered, 'intent.json'))
      // Missing registration still goes through closeRegistration's EXACT durable retirement receipt check.
      if (rawIntent !== undefined && !(observation && (observation.lifecycle === 'closed' || observation.bootId !== bootIdentity()
        || (observation.boundary && !cgroupPopulated(observation.boundary))))) throw new Error('Rsync process tree remains active or unconfirmed')
    }
    await this.completeProcess(ref, signal)
  }
  async processesQuiescent(input: TransferIntent, signal: AbortSignal, requireProcess = false) {
    const i = this.original(input), refs = this.references(i)
    if (!refs.length) throw new Error('Rsync causal ownership unavailable')
    const processes = refs.filter(ref => this.read(ref).row.binary)
    if (requireProcess && !processes.length) throw new Error('Rsync causal subprocess ownership unavailable')
    for (const ref of processes) await this.quiet(ref, signal, false)
  }
  async quiescent(input: TransferIntent, signal: AbortSignal) {
    const i = this.original(input), refs = this.references(i)
    if (!refs.length) throw new Error('Rsync causal ownership unavailable')
    for (const ref of refs) await this.quiet(ref, signal, false)
    if (readdirSync(this.root).some(name => name.startsWith(`${i.transferId}.`) && name.endsWith('.input'))) throw new Error('Rsync source-materializer residue retains its original hold')
  }
  async stopProcesses(input: TransferIntent, signal: AbortSignal) {
    const i = this.original(input)
    for (const ref of this.references(i)) if (this.read(ref).row.binary) await this.quiet(ref, signal, true)
    await this.processesQuiescent(i, signal)
  }
  async stop(input: TransferIntent, signal: AbortSignal) {
    const i = this.original(input)
    for (const ref of this.references(i)) await this.quiet(ref, signal, true)
    await this.quiescent(i, signal)
  }
  async drain(signal: AbortSignal) {
    this.draining = true
    const failures: unknown[] = []
    for (const i of this.inventory()) { try { await this.stop(i, signal) } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'Rsync byte ownership drain remains unconfirmed')
  }
  inventory(): TransferIntent[] {
    this.pin()
    const result: TransferIntent[] = []
    for (const name of readdirSync(this.journal)) {
      if (name === '.processes') continue
      if (!z.uuid().safeParse(name).success) throw new Error('Unexpected rsync owner journal entry')
      const i = TransferIntentSchema.parse(readRecord(join(this.journal, name, 'intent.json')))
      if (i.transferId !== name) throw new Error('Rsync owner journal identity conflicts')
      result.push(i)
      if (result.length > POLICY.maxRecords) throw new Error('Rsync owner inventory exceeds policy')
    }
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.intent')) continue
      const i = TransferIntentSchema.parse(readRecord(join(this.root, name)))
      if (name !== `${i.transferId}.intent`) throw new Error('Rsync staging inventory identity conflicts')
      const existing = result.find(row => row.transferId === i.transferId)
      if (existing && !isDeepStrictEqual(existing, i)) throw new Error('Rsync staging intent differs from original owner')
      if (!existing) result.push(i) // Expose legacy expiry; quiescent still denies missing causal ownership.
      if (result.length > POLICY.maxRecords) throw new Error('Rsync owner inventory exceeds policy')
    }
    return result
  }
  expiredInventory(now = Date.now()) { return this.inventory().filter(i => Date.parse(i.expiresAt) <= now) }
  access(input: TransferIntent, binding: Readonly<DeviceSessionBinding>, role: 'snapshot' | 'receiver' | 'source-materializer'): RsyncAccessLease {
    const ref = this.prepare(input, binding, role), { row, path } = this.read(ref)
    const handles = new Set<FileHandle>(), pending = new Set<Promise<unknown>>()
    let closing: Promise<void> | undefined
    const lease: RsyncAccessLease = {
      reference: ref,
      run: <T>(work: () => Promise<T>) => {
        if (closing) return Promise.reject(new Error('Rsync byte access closed'))
        this.admissible(row.intent); this.binding(row.intent, row.binding)
        const task = Promise.resolve().then(() => { this.admissible(row.intent); this.binding(row.intent, row.binding); return work() })
        pending.add(task)
        void task.finally(() => pending.delete(task)).catch(() => undefined)
        return task
      },
      attach: handle => { if (closing && !pending.size) throw new Error('Rsync byte access closed'); handles.add(handle) },
      captureLock: () => writeRecord(`${path}.lock`, { version: 1, ...ref, root: this.rootIdentity,
        lock: certificate(join(this.root, `${row.intent.transferId}.lock`)) }, true),
      close: () => closing ??= (async () => {
        await Promise.allSettled([...pending])
        await Promise.all([...handles].map(handle => handle.close()))
        if (row.hostBootId !== bootIdentity() || !isDeepStrictEqual(row.issuer, self())) throw new Error('Only original rsync access owner can publish drain')
        this.closed(ref, 'access-drained'); this.accesses.delete(ref.ownerId)
      })(),
    }
    this.accesses.set(ref.ownerId, lease)
    this.admissible(row.intent)
    return lease
  }
  assertLock(input: TransferIntent) {
    const i = this.original(input), actual = certificate(join(this.root, `${i.transferId}.lock`))
    let matches = 0
    for (const ref of this.references(i)) {
      const { path } = this.read(ref), raw = readRecord(`${path}.lock`)
      if (raw === undefined) continue
      const lock = Lock.parse(raw)
      if (lock.transferId !== ref.transferId || lock.ownerId !== ref.ownerId || lock.ownerDigest !== ref.ownerDigest || !isDeepStrictEqual(lock.root, this.rootIdentity)) throw new Error('Rsync writer lock owner conflicts')
      if (isDeepStrictEqual(lock.lock, actual)) matches++
    }
    if (matches !== 1) throw new Error('Exact rsync writer lock ownership unavailable')
  }
  async retire<T>(input: TransferIntent, work: () => Promise<T>): Promise<T> {
    const i = this.original(input), path = join(this.directory(i), 'retiring.json')
    if (readRecord(path) === undefined) writeRecord(path, { version: 1, intent: i }, true)
    await this.quiescent(i, AbortSignal.timeout(5000))
    return work()
  }
  store(): RsyncStoreOwnership {
    return { access: (i, role) => {
      const binding = this.current(i.deviceId)
      if (!binding) throw new Error('Rsync writer current binding unavailable')
      return this.access(i, binding, role)
    }, processesQuiescent: (i, s, required) => this.processesQuiescent(i, s, required), quiescent: (i, s) => this.quiescent(i, s),
    assertLock: i => this.assertLock(i), retire: (i, work) => this.retire(i, work) }
  }
}
export const rsyncArgumentDigest = (args: readonly string[]) => digest(args)
const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Called by the protected remote wrapper supplied by the common owner, with a LIVE W07 binding
 * reader. It causally registers the actual remote server before native config/stdio is admitted.
 * No installed-root/binary/credentials/current-binding fallback is synthesized here. */
export async function runRsyncRemoteServer(input: { ownership: RsyncWriterOwnership; reference: RsyncOwnerReference;
  args: string[]; signal: AbortSignal }): Promise<number> {
  const child = input.ownership.spawnServer(input.reference, input.args, input.signal)
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
  const stop = () => { void input.ownership.completeProcess(input.reference, AbortSignal.timeout(5000)).catch(error => process.stderr.write(`Rsync writer stop unconfirmed: ${String(error)}\n`)) }
  input.signal.addEventListener('abort', stop, { once: true }); if (input.signal.aborted) stop()
  try {
    const outcome = await new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (exitCode, exitSignal) => {
        try { resolve(nativeProcessExit(child, { exitCode, exitSignal })) } catch (error) { reject(error) }
      })
    })
    await input.ownership.completeProcess(input.reference, AbortSignal.timeout(5000))
    input.signal.throwIfAborted()
    return outcome.exitCode ?? 1
  } finally { process.stdin.unpipe(child.stdin); input.signal.removeEventListener('abort', stop) }
}
