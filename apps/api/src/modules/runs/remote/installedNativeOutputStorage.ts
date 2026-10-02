import { lstat } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { DispatchIntent } from '@graphql/contracts/node-placement'
import type { NativeSessionReference } from '@graphql/contracts'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@graphql/contracts/byte-transfer'
import { anchored, identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'

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
