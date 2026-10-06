import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, mkdir, rename, statfs, readdir, readlink, stat, readFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MaterializationReceiptSchema, RootBindingSchema, type MaterializationReceipt, type RootBinding, type SourceManifest } from '@foreman-code/contracts/source-materialization'
import { SOURCE_LIMITS, SourceError, sourcePath, verifySourceBytes, verifySourceManifest } from './manifest.js'
import { anchored, entryParent, identity, openChildDirectory, openPrivateRoot,
  withPrivateDirectoryLock } from './privateFilesystem.js'
import type { MaterializationAttempt, SourceByteReader, SourceMaterializationPort } from './ports.js'
import { SourcePreparationClosureSchema, type SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'

const equal = isDeepStrictEqual
export class PrivateSourceMaterializer implements SourceMaterializationPort {
  private active = 0
  constructor(private readonly bytes: SourceByteReader | null, private readonly authorize: (binding: RootBinding, attempt: MaterializationAttempt) => Promise<void>) {}
  async prepare(input: { manifest: SourceManifest; binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<MaterializationReceipt> {
    if (!this.bytes) throw new SourceError('SOURCE_READ_ONLY_VERIFIER', 'A verification-only materializer cannot prepare source bytes.')
    const manifest = verifySourceManifest(input.manifest), binding = RootBindingSchema.parse(input.binding)
    if (binding.snapshotId !== manifest.snapshotId || binding.manifestDigest !== manifest.manifestDigest)
      throw new SourceError('SOURCE_PIN_CONFLICT', 'The root is not bound to this exact source snapshot.')
    const attempt = input.attempt
    // Parse every accepted attempt pin before any I/O; the authorization port
    // rechecks current device/root/placement authority, never chooses a new pin.
    MaterializationReceiptSchema.shape.placementHash.parse(attempt.placementHash)
    MaterializationReceiptSchema.shape.executionId.parse(attempt.executionId)
    MaterializationReceiptSchema.shape.attemptId.parse(attempt.attemptId)
    MaterializationReceiptSchema.shape.keyRevision.parse(attempt.keyRevision)
    MaterializationReceiptSchema.shape.authorizationRevision.parse(attempt.authorizationRevision)
    if ((binding.deviceId === null) !== (binding.workerInstallationId === null)
      || (binding.deviceId === null) !== (attempt.keyRevision === null && attempt.authorizationRevision === null))
      throw new SourceError('SOURCE_HOST_IDENTITY_INVALID', 'Original-main roots have no worker registration; device roots require actual worker authorization pins.')
    await this.authorize(binding, attempt)
    const recovered = await this.recover(binding, attempt)
    if (recovered) return recovered
    if (this.active >= SOURCE_LIMITS.concurrent) throw new SourceError('SOURCE_CAPACITY', 'Materialization concurrency is exhausted.')
    this.active++
    const signal = AbortSignal.any([AbortSignal.timeout(SOURCE_LIMITS.preparationMs), ...(input.signal ? [input.signal] : [])])
    let root: FileHandle | undefined, reservation: FileHandle | undefined, tree: FileHandle | undefined, lock: FileHandle | undefined
    const id = randomUUID(), lockName = `binding-${binding.rootId}.lock`
    try {
      signal.throwIfAborted()
      root = await openPrivateRoot(binding.canonicalPath)
      if (!equal(await identity(root), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination filesystem identity changed.')
      await withPrivateDirectoryLock(root, async () => {
        lock = await open(anchored(root!, lockName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await lock.writeFile(JSON.stringify({ version: 1, materializationId: id, binding, attempt })); await lock.sync(); await root!.sync()
      })
      // Reservation covers staging, activated copy and retained/reference space.
      const disk = await statfs(anchored(root), { bigint: true })
      const required = BigInt(manifest.totalBytes * 3 + manifest.totalEntries * 8192 + 1024 * 1024)
      if (disk.bavail * disk.bsize < required) throw new SourceError('SOURCE_DISK_CAPACITY', 'Insufficient reserved space for source staging and execution copies.')
      await mkdir(anchored(root, id), { mode: 0o700 })
      reservation = await openChildDirectory(root, id)
      await mkdir(anchored(reservation, 'staging'), { mode: 0o700 })
      tree = await openChildDirectory(reservation, 'staging')
      for (const entry of manifest.entries) {
        signal.throwIfAborted()
        const content = await this.bytes.read(manifest, entry, signal)
        signal.throwIfAborted(); verifySourceBytes(entry, content)
        const { parent, leaf } = await entryParent(tree, entry.path, true)
        try {
          const file = await open(anchored(parent, leaf), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          try { await file.writeFile(content); await file.chmod(binding.accessMode === 'read-only' ? (entry.executable ? 0o500 : 0o400) : (entry.executable ? 0o700 : 0o600)); await file.sync() }
          finally { await file.close() }
          await parent.sync()
        } finally { await parent.close() }
      }
      await verifyMaterializedSourceTree(tree, manifest)
      signal.throwIfAborted(); await this.authorize(binding, attempt)
      const current = await openPrivateRoot(binding.canonicalPath)
      try { if (!equal(await identity(current), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root replaced before activation.') }
      finally { await current.close() }
      const receipt = MaterializationReceiptSchema.parse({ version: 1, materializationId: id, binding, ...attempt,
        verifiedManifestDigest: manifest.manifestDigest, verifiedEntries: manifest.totalEntries,
        verifiedBytes: manifest.totalBytes, verifiedAt: new Date().toISOString(), localTreeIdentity: await identity(tree) })
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await record.writeFile(JSON.stringify({ receipt, manifest })); await record.sync() } finally { await record.close() }
      await tree.sync()
      // The fresh UUID reservation is exclusively app-owned. Its tree name has
      // never existed; rename cannot overwrite a caller or an execution tree.
      signal.throwIfAborted()
      await rename(anchored(reservation, 'staging'), anchored(reservation, 'tree'))
      await reservation.sync(); await root.sync()
      return receipt
    } finally {
      await tree?.close(); await reservation?.close(); await lock?.close(); await root?.close(); this.active--
      // Retain the binding lock even on failure/uncertain activation. Only
      // W08/W01 reconciliation may release it or reclaim its private directory.
    }
  }
  /** Exact lost-activation-ack recovery. Incomplete claims remain uncertain;
   * no new directory/attempt is allocated and no old claim is discarded. */
  async recover(binding: RootBinding, attempt: MaterializationAttempt): Promise<MaterializationReceipt | null> {
    RootBindingSchema.parse(binding); await this.authorize(binding, attempt)
    const root = await openPrivateRoot(binding.canonicalPath)
    try {
      if (!equal(await identity(root), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
      const lock = await open(anchored(root, `binding-${binding.rootId}.lock`), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (!lock) return null
      let claim: { materializationId: string; binding: RootBinding; attempt: MaterializationAttempt }
      try {
        const stat = await lock.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_CLAIM_INVALID', 'Invalid source ownership claim.')
        claim = JSON.parse(await lock.readFile('utf8')) as typeof claim
      } finally { await lock.close() }
      MaterializationReceiptSchema.shape.materializationId.parse(claim.materializationId)
      if (!equal(claim.binding, binding) || !equal(claim.attempt, attempt)) throw new SourceError('SOURCE_ROOT_OWNED', 'The root belongs to another accepted execution/attempt.')
      const directory = await openChildDirectory(root, claim.materializationId)
      let receipt: MaterializationReceipt
      try {
        const file = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid source receipt record.')
          receipt = MaterializationReceiptSchema.parse((JSON.parse(await file.readFile('utf8')) as { receipt: unknown }).receipt)
        } finally { await file.close() }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN', 'The original activation is incomplete; reconcile this exact attempt before retry.')
        throw error
      } finally { await directory.close() }
      await this.verify(receipt, { binding, attempt }); return receipt
    } finally { await root.close() }
  }
  async verify(input: MaterializationReceipt, expected: { binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<void> {
    expected.signal?.throwIfAborted()
    const receipt = MaterializationReceiptSchema.parse(input)
    if (!equal(receipt.binding, RootBindingSchema.parse(expected.binding)) || !equal({ placementHash: receipt.placementHash,
      executionId: receipt.executionId, attemptId: receipt.attemptId, keyRevision: receipt.keyRevision,
      authorizationRevision: receipt.authorizationRevision }, expected.attempt)) throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Materialization does not match the accepted root and attempt.')
    await this.authorize(receipt.binding, expected.attempt)
    const root = await openPrivateRoot(receipt.binding.canonicalPath)
    try {
      if (!equal(await identity(root), receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
      const directory = await openChildDirectory(root, receipt.materializationId)
      try {
        const record = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        let stored: { receipt: MaterializationReceipt; manifest: SourceManifest }
        try {
          const stat = await record.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid receipt record.')
          stored = JSON.parse(await record.readFile('utf8')) as typeof stored
        } finally { await record.close() }
        const manifest = verifySourceManifest(stored.manifest)
        if (!equal(stored.receipt, receipt) || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.snapshotId !== receipt.binding.snapshotId
          || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Stored source receipt changed.')
        const tree = await openChildDirectory(directory, 'tree')
        try {
          if (!equal(await identity(tree), receipt.localTreeIdentity)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Materialized tree replaced.')
          await verifyMaterializedSourceTree(tree, manifest, expected.signal)
        } finally { await tree.close() }
      } finally { await directory.close() }
    } finally { await root.close() }
  }
  async resolve(receipt: MaterializationReceipt, expected: { binding: RootBinding; attempt: MaterializationAttempt; signal?: AbortSignal }): Promise<string> {
    await this.verify(receipt, expected)
    return join(receipt.binding.canonicalPath, receipt.materializationId, 'tree')
  }
}
export async function verifyMaterializedSourceTree(tree: FileHandle, manifest: SourceManifest, signal?: AbortSignal): Promise<void> {
  const expected = new Set(manifest.entries.map((entry) => entry.path))
  const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
    for (const item of await readdir(anchored(directory), { withFileTypes: true })) {
      signal?.throwIfAborted()
      const path = prefix ? `${prefix}/${item.name}` : item.name
      sourcePath(path)
      if (item.isDirectory()) {
        if (!manifest.entries.some((entry) => entry.path.startsWith(`${path}/`))) throw new SourceError('SOURCE_TREE_EXTRA', 'Unexpected materialization directory.')
        const child = await openChildDirectory(directory, item.name)
        try { await walk(child, path) } finally { await child.close() }
      } else if (!item.isFile() || !expected.has(path)) throw new SourceError('SOURCE_TREE_EXTRA', 'Unexpected materialization entry.')
    }
  }
  await walk(tree, '')
  for (const entry of manifest.entries) {
    signal?.throwIfAborted()
    const { parent, leaf } = await entryParent(tree, entry.path, false)
    try {
      const file = await open(anchored(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.byteSize || !!(stat.mode & 0o111) !== entry.executable)
          throw new SourceError('SOURCE_TREE_INVALID', 'Materialized kind, size, link count or executable policy changed.')
        verifySourceBytes(entry, await file.readFile({ signal }))
      } finally { await file.close() }
    } finally { await parent.close() }
  }
}

/** Called only after authoritative execution reconciliation, never on disconnect. */
export async function releaseMaterializationClaim(receipt: MaterializationReceipt, reconcile: () => Promise<'released' | 'owned' | 'uncertain'>): Promise<void> {
  return archiveMaterializationClaim(receipt, { filesystem: receipt.binding.filesystem }, reconcile)
}

/** Only the separately signed original-Job cleanup grant can authorize a restored volume. */
export async function releaseMaterializationClaimForCancellation(receipt: MaterializationReceipt,
  filesystem: RootBinding['filesystem'], reconcile: () => Promise<'released' | 'owned' | 'uncertain'>): Promise<void> {
  RootBindingSchema.shape.filesystem.parse(filesystem)
  if (filesystem.inode !== receipt.binding.filesystem.inode) {
    throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source root inode changed.')
  }
  return archiveMaterializationClaim(receipt, { filesystem, verifyOriginalSource: true }, reconcile)
}

async function archiveMaterializationClaim(receipt: MaterializationReceipt,
  options: { filesystem: RootBinding['filesystem']; verifyOriginalSource?: true },
  reconcile: () => Promise<'released' | 'owned' | 'uncertain'>): Promise<void> {
  MaterializationReceiptSchema.parse(receipt)
  if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
  const binding = receipt.binding, root = await openPrivateRoot(binding.canonicalPath)
  try {
    if (!equal(await identity(root), options.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    await withPrivateDirectoryLock(root, async () => {
      if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
      const name = `binding-${binding.rootId}.lock`, releasedName = 'released-claim.json'
      const directory = await openChildDirectory(root, receipt.materializationId)
      const validateClaim = async (lock: FileHandle): Promise<void> => {
        const stat = await lock.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_CLAIM_INVALID', 'Invalid binding claim.')
        const claim = JSON.parse(await lock.readFile('utf8')) as { version: number; materializationId: string; binding: RootBinding; attempt: MaterializationAttempt }
        if (claim.version !== 1 || claim.materializationId !== receipt.materializationId || !equal(claim.binding, binding)
          || !equal(claim.attempt, { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId, keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }))
          throw new SourceError('SOURCE_CLAIM_CONFLICT', 'This receipt does not own the destination claim.')
      }
      try {
        // The archived claim identifies the exact original owner; the immutable
        // activation record binds replay to every fact of the original receipt.
        const record = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await record.stat()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid receipt record.')
          const stored = JSON.parse(await record.readFile('utf8')) as { receipt: unknown; manifest: unknown }
          if (!equal(stored.receipt, receipt)) {
            throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Release does not match the exact original materialization receipt.')
          }
          if (options.verifyOriginalSource) {
            const manifest = verifySourceManifest(stored.manifest)
            if (manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.snapshotId !== binding.snapshotId
              || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes) {
              throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'The original verified source manifest changed.')
            }
            const tree = await openChildDirectory(directory, 'tree')
            try {
              const expected = { ...receipt.localTreeIdentity, device: options.filesystem.device,
                mountId: options.filesystem.mountId }
              if (!equal(await identity(tree), expected)) throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source tree inode changed.')
              await verifyMaterializedSourceTree(tree, manifest)
            } finally { await tree.close() }
          }
        } finally { await record.close() }
        const released = await open(anchored(directory, releasedName), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
          throw error
        })
        if (released) {
          if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
          try { await validateClaim(released); await released.sync() } finally { await released.close() }
          // Finish durability after a crash/lost ACK during the original rename.
          // Never inspect or delete a successor claim on this replay branch.
          await directory.sync(); await root.sync(); return
        }
        const lock = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          await validateClaim(lock)
          const current = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            if (!equal(await identity(current), await identity(lock))) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'The validated destination claim was replaced.')
          } finally { await current.close() }
          // Atomically remove active ownership AND preserve its original claim.
          // Absence alone is never accepted as evidence that release completed.
          if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
          await rename(anchored(root, name), anchored(directory, releasedName))
          await lock.sync(); await directory.sync(); await root.sync()
        } finally { await lock.close() }
      } finally { await directory.close() }
    })
  } finally { await root.close() }
}

/** A new worker generation cannot infer closure from its empty in-memory task
 * set. Look for same-UID processes using the original private namespace, without
 * exposing argv or accepting PID/path assertions from the caller. */
export async function preparationChildrenClosed(namespace: string): Promise<boolean> {
  const entries = await readdir('/proc')
  if (entries.length > 32768) {
    throw new SourceError('source-reconciliation-unconfirmed', 'Process inspection exceeded its process limit.')
  }
  const inside = (path: string) => path === namespace || path.startsWith(namespace + '/')
  for (const pid of entries.filter(value => /^\d+$/.test(value) && Number(value) !== process.pid)) {
    const directory = `/proc/${pid}`
    try {
      if ((await stat(directory)).uid !== process.getuid?.()) continue
      // Only binaries used by installed source/native producers can own this
      // preparation. Unrelated protected login/database daemons are not its
      // children; requiring ptrace access to them would invent host authority.
      const comm = (await readFile(`${directory}/comm`, 'utf8')).trim()
      if (!['git', 'flock', 'node', 'rsync', 'podman', 'crun'].includes(comm)) continue
      if (inside(await readlink(`${directory}/cwd`))) {
        throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} still uses the source directory.`)
      }
      const args = await open(`${directory}/cmdline`, constants.O_RDONLY)
      try {
        const bytes = Buffer.alloc(65536), result = await args.read(bytes, 0, bytes.length, 0)
        if (result.bytesRead === bytes.length) {
          throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} exceeded the argument inspection limit.`)
        }
        if (bytes.subarray(0, result.bytesRead).toString().split('\0').some(inside)) {
          throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} still references the source directory.`)
        }
      } finally { await args.close() }
      const descriptors = await readdir(`${directory}/fd`)
      if (descriptors.length > 8192) {
        throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} exceeded the descriptor inspection limit.`)
      }
      for (const fd of descriptors) {
        if (inside(await readlink(`${directory}/fd/${fd}`))) {
          throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} still holds a source descriptor.`)
        }
      }
    } catch (error) {
      if (error instanceof SourceError) throw error
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new SourceError('source-reconciliation-unconfirmed', `Process ${pid} could not be inspected.`, { cause: error })
      }
    }
  }
  return true
}

/** Archive only this original binding claim. Source trees, private repositories,
 * transfer evidence and receipts remain intact, including incomplete copies. */
export async function reconcileSourcePreparation(reconciliationId: string, owner: SourceOperationOwner,
  nativeClosed: () => Promise<boolean>, reauthorize: () => Promise<void>): Promise<SourcePreparationClosure> {
  SourcePreparationClosureSchema.shape.reconciliationId.parse(reconciliationId)
  if (owner.preparationClosed !== true) throw new SourceError('source-reconciliation-unconfirmed', 'Main preparation admission closure is not confirmed.')
  await reauthorize()
  const binding = RootBindingSchema.parse(owner.root.binding), root = await openPrivateRoot(binding.canonicalPath)
  try {
    if (!equal(await identity(root), binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Original source cleanup root changed.')
    return await withPrivateDirectoryLock(root, async () => {
      const proofName = `closed-preparation-${reconciliationId}.json`, archiveName = `closed-preparation-${reconciliationId}.claim.json`
      const readRecord = async (name: string) => {
        const file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 16384)
            throw new SourceError('SOURCE_CLAIM_INVALID', 'Invalid original preparation cleanup record.')
          return JSON.parse(await file.readFile('utf8')) as unknown
        } finally { await file.close() }
      }
      const optionalRecord = async (name: string) => readRecord(name).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      const prior = await optionalRecord(proofName)
      if (prior) {
        const proof = SourcePreparationClosureSchema.parse(prior)
        if (proof.reconciliationId !== reconciliationId || proof.operationId !== owner.identity.operationId || proof.executionId !== owner.attempt.executionId
          || proof.attemptId !== owner.attempt.attemptId || proof.rootId !== binding.rootId || proof.bindingRevision !== binding.bindingRevision
          || !equal(proof.filesystem, binding.filesystem)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Closure proof belongs to another original preparation.')
        await reauthorize(); return proof
      }
      if (!await nativeClosed()) {
        throw new SourceError('source-reconciliation-unconfirmed', 'The native owner has not confirmed closure.')
      }
      await preparationChildrenClosed(binding.canonicalPath)
      await reauthorize()
      const lockName = `binding-${binding.rootId}.lock`, archive = await optionalRecord(archiveName), current = archive ?? await optionalRecord(lockName)
      let materializationId = owner.record?.receipt.materializationId ?? null
      if (current) {
        const claim = current as { version: number; materializationId: string; binding: RootBinding; attempt: MaterializationAttempt }
        if (claim.version !== 1 || !equal(claim.binding, binding)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'The original binding claim changed.')
        MaterializationReceiptSchema.shape.materializationId.parse(claim.materializationId)
        if (equal(claim.attempt, owner.attempt)) {
          if (materializationId !== null && materializationId !== claim.materializationId) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'The original materialization claim changed.')
          materializationId = claim.materializationId
          if (!archive) await rename(anchored(root, lockName), anchored(root, archiveName))
        } else if (archive || materializationId !== null) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup cannot release another preparation claim.')
        // A pre-activation failure may never have acquired this binding; retain
        // an unrelated current claim and every copy while closing that failure.
      } else if (materializationId !== null) {
        const directory = await openChildDirectory(root, materializationId)
        try {
          const file = await open(anchored(directory, 'released-claim.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_CLAIM_INVALID', 'Original release evidence is invalid.')
            const released = JSON.parse(await file.readFile('utf8')) as { materializationId: string; binding: RootBinding; attempt: MaterializationAttempt }
            if (released.materializationId !== materializationId || !equal(released.binding, binding) || !equal(released.attempt, owner.attempt))
              throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Original release evidence belongs to another attempt.')
          } finally { await file.close() }
        } finally { await directory.close() }
      }
      const proof = SourcePreparationClosureSchema.parse({ version: 1, reconciliationId, operationId: owner.identity.operationId,
        executionId: owner.attempt.executionId, attemptId: owner.attempt.attemptId, rootId: binding.rootId, bindingRevision: binding.bindingRevision,
        materializationId, mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
        keyRevision: owner.attempt.keyRevision, authorizationRevision: owner.attempt.authorizationRevision, filesystem: binding.filesystem,
        admissionClosed: true, childrenClosed: true, claimReleased: true, evidencePreserved: true, observedAt: new Date().toISOString() })
      const file = await open(anchored(root, proofName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(JSON.stringify(proof)); await file.sync() } finally { await file.close() }
      await root.sync(); await reauthorize(); return proof
    }, { nonBlocking: true })
  } finally { await root.close() }
}
