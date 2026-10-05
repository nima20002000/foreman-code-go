import { constants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { lstat, open, rename, readdir, type FileHandle } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DispatchIntentSchema, type DispatchIntent } from '@foreman-code/contracts/node-placement'
import { NativeSessionReferenceSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { anchored, identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'
import { acquireNativeOutputBudgetLock } from './nativeOutputBudgetLock.js'

/** Captured by the actual admitted turn, never supplied in a native command. */
export interface NativeOutputStorageOwner {
  intent: DispatchIntent
  binding: Readonly<DeviceSessionBinding>
  session: NativeSessionReference
  nativeTurnId: string
  runtimeGeneration: number
}
export interface NativeOutputStorageLimits {
  maxDiskBytes: number
  maxSnapshotBytes: number
  maxCommandRecords: number
}
/** The original durable ledger enforces these limits atomically across ALL turns,
 * instances and crash-left reservations. An in-memory counter is not this port. */
export interface NativeOutputBudgetLedger {
  reserve(input: { owner: NativeOutputStorageOwner; artifactId: string;
    limits: NativeOutputStorageLimits; requested: NativeOutputStorageLimits }, signal?: AbortSignal): Promise<{
    assertCurrent(signal?: AbortSignal): Promise<void>
    release(): Promise<void>
  }>
}
export interface NativeOutputProtection {
  /** Genuine exact-binary qualification plus actual enforced sandbox/root proof;
   * checks original session/process/generation and root identity after awaits. */
  assertProtected(owner: NativeOutputStorageOwner, signal?: AbortSignal): Promise<void>
  /** Original native writers AND snapshot readers are positively stopped. This
   * cleanup proof must still work after withdrawal/revocation, without new grants. */
  assertQuiescent(owner: NativeOutputStorageOwner, artifactId: string): Promise<void>
}
export interface InstalledNativeOutputStorageInput {
  rootDirectory: string
  owner: NativeOutputStorageOwner
  limits: NativeOutputStorageLimits
  budget: NativeOutputBudgetLedger
  protection: NativeOutputProtection
  assertCurrent(signal?: AbortSignal): Promise<void>
}
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE',
  'Original qualified native output storage or budget is unavailable.', 409)
const Limits = z.object({ maxDiskBytes: z.number().int().positive().safe(),
  maxSnapshotBytes: z.number().int().positive().safe(), maxCommandRecords: z.number().int().positive().safe() }).strict()
const ArtifactId = z.uuid()

/** This rejects obvious writable-root overlaps; only actual native qualification
 * can establish enforcement. It never replaces protection.assertProtected. */
export function assertNativeOutputRootExcluded(root: string, writableRoots: readonly string[]): void {
  if (!isAbsolute(root) || writableRoots.some(writable => {
    if (!isAbsolute(writable)) return true
    const fromWritable = relative(writable, root), fromPrivate = relative(root, writable)
    const inside = (value: string) => value === '' || value !== '..' && !value.startsWith('../') && !isAbsolute(value)
    return inside(fromWritable) || inside(fromPrivate)
  })) throw unavailable()
}

/** No directory creation, private-root selection, qualification or budget default.
 * The returned shape is the W09 storage port, independently of producer imports. */
export async function createInstalledNativeOutputStorage(input: InstalledNativeOutputStorageInput) {
  const owner = structuredClone(input.owner), limits = Limits.parse(input.limits)
  if (!owner.nativeTurnId || !Number.isSafeInteger(owner.runtimeGeneration) || owner.runtimeGeneration < 1
    || owner.session.harness !== 'codex' || owner.intent.mainId !== owner.binding.mainId) throw unavailable()
  await input.assertCurrent(); await input.protection.assertProtected(owner)
  const root = await openPrivateRoot(input.rootDirectory)
  let pinned: Awaited<ReturnType<typeof identity>>
  try { pinned = await identity(root) } finally { await root.close() }
  const checkRoot = async () => {
    const current = await openPrivateRoot(input.rootDirectory)
    try { if (!isDeepStrictEqual(await identity(current), pinned)) throw unavailable() }
    finally { await current.close() }
  }
  const assertProtected = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    await input.assertCurrent(signal); signal?.throwIfAborted()
    await input.protection.assertProtected(owner, signal); signal?.throwIfAborted()
    await checkRoot(); signal?.throwIfAborted()
    await input.assertCurrent(signal); signal?.throwIfAborted()
  }
  await assertProtected()
  return {
    rootDirectory: input.rootDirectory,
    assertProtected,
    reserve: async (raw: { artifactId: string } & NativeOutputStorageLimits, signal?: AbortSignal) => {
      const artifactId = ArtifactId.parse(raw.artifactId)
      const requested = Limits.parse({ maxDiskBytes: raw.maxDiskBytes, maxSnapshotBytes: raw.maxSnapshotBytes,
        maxCommandRecords: raw.maxCommandRecords })
      if (requested.maxDiskBytes > MAX_FILE_BYTES || requested.maxSnapshotBytes > MAX_FILE_BYTES
        || requested.maxCommandRecords > BYTE_TRANSFER_POLICY.maxRecords
        || Object.keys(requested).some(key => requested[key as keyof NativeOutputStorageLimits] > limits[key as keyof NativeOutputStorageLimits])) throw unavailable()
      await assertProtected(signal)
      const reservation = await input.budget.reserve({ owner: structuredClone(owner), artifactId,
        limits: { ...limits }, requested }, signal)
      // Failed post-reservation checks retain the durable charge. No bytes are
      // exposed and no uncertain release is inferred from this request failure.
      await assertProtected(signal); await reservation.assertCurrent(signal)
      return {
        assertCurrent: async (bounded?: AbortSignal) => {
          await assertProtected(bounded); await reservation.assertCurrent(bounded)
          await assertProtected(bounded)
        },
        release: async () => {
          // Cleanup does not depend on a live mutation grant. Original positive
          // closure plus absent bytes is required, including retries after stop.
          await input.protection.assertQuiescent(owner, artifactId)
          await checkRoot()
          const directory = await openPrivateRoot(input.rootDirectory)
          try {
            if (!isDeepStrictEqual(await identity(directory), pinned)) throw unavailable()
            try { await lstat(anchored(directory, artifactId)); throw unavailable() }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
            await input.protection.assertQuiescent(owner, artifactId)
            await checkRoot()
            await reservation.release()
          } finally { await directory.close() }
        },
      }
    },
  }
}

const BudgetOwner = z.object({ intent: DispatchIntentSchema, binding: DeviceSessionBindingSchema,
  session: NativeSessionReferenceSchema, nativeTurnId: z.string().min(1).max(500), runtimeGeneration: z.number().int().positive() }).strict()
const BudgetRecord = z.object({ artifactId: ArtifactId, owner: BudgetOwner, requested: Limits, released: z.boolean() }).strict()
const BudgetRetirement = z.object({ version: z.literal(1), artifactId: ArtifactId,
  reservationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()
const Installation = DeviceSessionBindingSchema.pick({ mainId: true, deviceId: true, workerInstallationId: true })
const BudgetJournal = z.object({ version: z.literal(1), installation: Installation, limits: Limits,
  records: z.array(BudgetRecord).max(BYTE_TRANSFER_POLICY.maxRecords).refine(records => new Set(records.map(record => record.artifactId)).size === records.length) }).strict()

/** The installation supplies explicit caps and a protected root. Restart retains
 * reservations until the original native writers and readers are closed. */
export async function createNativeOutputBudgetLedger(input: {
  rootDirectory: string
  installation: z.infer<typeof Installation>
  limits: NativeOutputStorageLimits
  initializeNewStore?: true
  stoppedWorker?: true
}): Promise<NativeOutputBudgetLedger> {
  const installation = Installation.parse(input.installation), limits = Limits.parse(input.limits)
  if (limits.maxDiskBytes > BYTE_TRANSFER_POLICY.maxStagingBytes || limits.maxSnapshotBytes > BYTE_TRANSFER_POLICY.maxStagingBytes
    || limits.maxCommandRecords > BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal) throw unavailable()
  const initial = await openPrivateRoot(input.rootDirectory)
  let pinned: Awaited<ReturnType<typeof identity>>
  try { pinned = await identity(initial) } finally { await initial.close() }
  const locked = async <T>(operation: (root: FileHandle, files: Set<FileHandle>) => Promise<T>,
    signal?: AbortSignal) => {
    const root = await openPrivateRoot(input.rootDirectory)
    const files = new Set<FileHandle>()
    let lock: Awaited<ReturnType<typeof acquireNativeOutputBudgetLock>> | undefined
    try {
      if (!isDeepStrictEqual(await identity(root), pinned)) throw unavailable()
      lock = await acquireNativeOutputBudgetLock(root, { signal, stoppedWorker: input.stoppedWorker })
      signal?.throwIfAborted()
      if (!isDeepStrictEqual(await identity(root), pinned)) throw unavailable()
      return await operation(root, files)
    } finally {
      try { await lock?.close() }
      finally { await root.close() }
    }
  }
  const close = async (file: FileHandle, files: Set<FileHandle>) => { await file.close(); files.delete(file) }
  const read = async (root: FileHandle, files: Set<FileHandle>) => {
    const file = await open(anchored(root, '.native-output-budget.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    files.add(file)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.()
        || stat.size > BYTE_TRANSFER_POLICY.maxRecords * 16_384) throw unavailable()
      const envelope = z.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/), payload: BudgetJournal }).strict().parse(JSON.parse(await file.readFile('utf8')))
      if (createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex') !== envelope.checksum) throw unavailable()
      const journal = envelope.payload
      if (!isDeepStrictEqual(journal.installation, installation) || !isDeepStrictEqual(journal.limits, limits)) throw unavailable()
      return journal
    } finally { await close(file, files) }
  }
  const write = async (root: FileHandle, files: Set<FileHandle>, destination: string, encoded: string) => {
    const name = `.native-output-budget-${randomUUID()}.tmp`
    const file = await open(anchored(root, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    files.add(file)
    try {
      await file.writeFile(encoded)
      await file.sync()
    } finally {
      await close(file, files)
    }
    await rename(anchored(root, name), anchored(root, destination))
    await root.sync()
  }
  const save = async (root: FileHandle, files: Set<FileHandle>, journal: z.infer<typeof BudgetJournal>) => {
    const payload = BudgetJournal.parse(journal)
    const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const encoded = JSON.stringify({ checksum, payload })
    if (Buffer.byteLength(encoded) > BYTE_TRANSFER_POLICY.maxRecords * 16_384) throw unavailable()
    await write(root, files, '.native-output-budget.json', encoded)
  }
  const retirementName = (artifactId: string) => `.native-output-retired-${artifactId}.json`
  const retirementFor = (record: Pick<z.infer<typeof BudgetRecord>, 'artifactId' | 'owner' | 'requested'>) =>
    BudgetRetirement.parse({ version: 1, artifactId: record.artifactId,
      reservationHash: commandInputHash({ owner: record.owner, requested: record.requested }) })
  const readRetirement = async (root: FileHandle, files: Set<FileHandle>, artifactId: string) => {
    let file: FileHandle
    try {
      file = await open(anchored(root, retirementName(artifactId)),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    files.add(file)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077
        || stat.uid !== process.getuid?.() || stat.size > 1024) throw unavailable()
      const retirement = BudgetRetirement.parse(JSON.parse(await file.readFile('utf8')))
      if (retirement.artifactId !== artifactId) throw unavailable()
      return retirement
    } finally {
      await close(file, files)
    }
  }
  const retire = async (root: FileHandle, files: Set<FileHandle>, record: z.infer<typeof BudgetRecord>) => {
    const expected = retirementFor(record)
    const existing = await readRetirement(root, files, record.artifactId)
    if (existing) {
      if (!isDeepStrictEqual(existing, expected)) throw unavailable()
      return
    }
    await write(root, files, retirementName(record.artifactId), JSON.stringify(expected))
  }
  const recoverRetirements = async (root: FileHandle, files: Set<FileHandle>,
    journal: z.infer<typeof BudgetJournal>) => {
    const active: z.infer<typeof BudgetRecord>[] = []
    for (const record of journal.records) {
      const retirement = await readRetirement(root, files, record.artifactId)
      if (retirement && !isDeepStrictEqual(retirement, retirementFor(record))) throw unavailable()
      if (record.released) await retire(root, files, record)
      else if (!retirement) active.push(record)
    }
    if (active.length === journal.records.length) return
    journal.records = active
    await save(root, files, journal)
  }
  await locked(async (root, files) => {
    let journal: z.infer<typeof BudgetJournal>
    try {
      journal = await read(root, files)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') || !input.initializeNewStore) throw error
      const entries = await readdir(anchored(root))
      const initializationEntry = (name: string) => name === '.native-output-budget.guard'
        || name === '.native-output-budget-owner.json'
        || /^\.native-output-budget-(?:owner-)?[a-f0-9-]{36}\.tmp$/.test(name)
        || /^\.native-output-budget-retired-(?:owner-[a-f0-9-]{36}\.json|lock-[a-f0-9-]{36})$/.test(name)
      if (!entries.every(initializationEntry)) throw unavailable()
      await save(root, files, { version: 1, installation, limits, records: [] })
      return
    }
    await recoverRetirements(root, files, journal)
  })
  return { reserve: async (raw, signal) => {
    const owner = BudgetOwner.parse(raw.owner), requested = Limits.parse(raw.requested), artifactId = ArtifactId.parse(raw.artifactId)
    if (owner.session.harness !== 'codex' || owner.intent.mainId !== installation.mainId
      || !isDeepStrictEqual({ mainId: owner.binding.mainId, deviceId: owner.binding.deviceId, workerInstallationId: owner.binding.workerInstallationId }, installation) || !isDeepStrictEqual(raw.limits, limits)) throw unavailable()
    const exact = (record: z.infer<typeof BudgetRecord> | undefined) => {
      if (!record || record.released || !isDeepStrictEqual(record.owner, owner) || !isDeepStrictEqual(record.requested, requested)) throw unavailable()
      return record
    }
    signal?.throwIfAborted()
    await locked(async (root, files) => {
      const journal = await read(root, files), existing = journal.records.find(record => record.artifactId === artifactId)
      if (await readRetirement(root, files, artifactId)) throw unavailable()
      if (existing) { exact(existing); return }
      if (journal.records.length >= BYTE_TRANSFER_POLICY.maxRecords) throw unavailable()
      for (const key of ['maxDiskBytes', 'maxSnapshotBytes'] as const) {
        const reserved = journal.records.filter(record => !record.released).reduce((sum, record) => sum + record.requested[key], 0)
        if (reserved + requested[key] > limits[key]) throw unavailable()
      }
      // One original turn owns one command registry, shared by all its artifacts.
      const registries = new Map<string, number>()
      for (const record of [...journal.records.filter(record => !record.released), { owner, requested }]) {
        const registryId = commandInputHash(record.owner)
        const reserved = registries.get(registryId) ?? 0
        registries.set(registryId, Math.max(reserved, record.requested.maxCommandRecords))
      }
      const commandRecords = [...registries.values()].reduce((sum, reserved) => sum + reserved, 0)
      if (commandRecords > limits.maxCommandRecords) throw unavailable()
      signal?.throwIfAborted()
      journal.records.push({ artifactId, owner, requested, released: false }); await save(root, files, journal)
      signal?.throwIfAborted()
    }, signal)
    return {
      assertCurrent: async bounded => {
        bounded?.throwIfAborted()
        await locked(async (root, files) => {
          if (await readRetirement(root, files, artifactId)) throw unavailable()
          exact((await read(root, files)).records.find(record => record.artifactId === artifactId))
          bounded?.throwIfAborted()
        }, bounded)
      },
      release: async () => {
        await locked(async (root, files) => {
          const journal = await read(root, files)
          const record = journal.records.find(record => record.artifactId === artifactId)
          const retirement = await readRetirement(root, files, artifactId)
          if (retirement && !isDeepStrictEqual(retirement, retirementFor({ artifactId, owner, requested }))) {
            throw unavailable()
          }
          if (retirement && !record) return
          if (!record || !isDeepStrictEqual(record.owner, owner) || !isDeepStrictEqual(record.requested, requested)) {
            throw unavailable()
          }
          // Persist the retry record before removing the active charge.
          await retire(root, files, record)
          journal.records = journal.records.filter(record => record.artifactId !== artifactId)
          await save(root, files, journal)
        })
      },
    }
  } }
}
