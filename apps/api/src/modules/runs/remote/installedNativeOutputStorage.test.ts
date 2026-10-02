import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rename, rm, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DispatchIntentSchema } from '@graphql/contracts/node-placement'
import { DeviceSessionBindingSchema } from '@graphql/contracts/device-connection'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@graphql/contracts/byte-transfer'
import { createInstalledNativeOutputStorage, assertNativeOutputRootExcluded,
  type InstalledNativeOutputStorageInput } from './installedNativeOutputStorage.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp('/tmp/native-output-storage-'); roots.push(root)
  const rootDirectory = join(root, 'private'); await mkdir(rootDirectory, { mode: 0o700 })
  const mainId = randomUUID()
  const intent = DispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId, runId: 'run', nodeId: 'node',
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt',
    operationId: 'operation', bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } })
  const binding = DeviceSessionBindingSchema.parse({ mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 })
  const limits = { maxDiskBytes: MAX_FILE_BYTES, maxSnapshotBytes: MAX_FILE_BYTES, maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords }
  const release = vi.fn(async () => {}), reservationCurrent = vi.fn(async () => {})
  // Contract doubles only. These do not establish actual native qualification or
  // a production durable ledger; the adapter must require their real providers.
  const input: InstalledNativeOutputStorageInput = { rootDirectory,
    owner: { intent, binding, session: { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'native-session' },
      nativeTurnId: 'original-turn', runtimeGeneration: 1 }, limits,
    assertCurrent: vi.fn(async () => {}),
    protection: { assertProtected: vi.fn(async () => {}), assertQuiescent: vi.fn(async () => {}) },
    budget: { reserve: vi.fn(async () => ({ assertCurrent: reservationCurrent, release })) } }
  return { root, input, release, reservationCurrent, request: { artifactId: randomUUID(), ...limits } }
}

describe('explicit qualified native storage adapter, no native acceptance', () => {
  it('never substitutes directory mode for qualification or reserves after denial', async () => {
    const f = await fixture()
    vi.mocked(f.input.protection.assertProtected).mockRejectedValue(new Error('No actual qualification'))
    await expect(createInstalledNativeOutputStorage(f.input)).rejects.toThrow('No actual qualification')
    expect(f.input.budget.reserve).not.toHaveBeenCalled()
  })
  it('passes exact original identity and aggregate caps to the durable provider', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    const reservation = await storage.reserve(f.request)
    expect(f.input.budget.reserve).toHaveBeenCalledWith({ owner: f.input.owner,
      artifactId: f.request.artifactId, limits: f.input.limits,
      requested: f.input.limits }, undefined)
    await reservation.assertCurrent()
    expect(f.reservationCurrent).toHaveBeenCalledTimes(2)
    await expect(storage.reserve({ ...f.request, maxDiskBytes: MAX_FILE_BYTES + 1 })).rejects.toThrow()
    expect(f.input.budget.reserve).toHaveBeenCalledTimes(1)
  })
  it('retains the original reservation when protection changes after admission', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    vi.mocked(f.input.budget.reserve).mockImplementationOnce(async () => {
      vi.mocked(f.input.protection.assertProtected).mockRejectedValue(new Error('Original owner changed'))
      return { assertCurrent: f.reservationCurrent, release: f.release }
    })
    await expect(storage.reserve(f.request)).rejects.toThrow('Original owner changed')
    expect(f.release).not.toHaveBeenCalled()
  })
  it('rejects retargeted private roots before reserving or releasing', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    const reservation = await storage.reserve(f.request)
    await rename(f.input.rootDirectory, join(f.root, 'original'))
    await mkdir(f.input.rootDirectory, { mode: 0o700 })
    await expect(reservation.assertCurrent()).rejects.toThrow()
    await expect(reservation.release()).rejects.toThrow()
    expect(f.release).not.toHaveBeenCalled()
  })
  it('releases only absent bytes with positive original writer/reader closure; retry survives withdrawal', async () => {
    const f = await fixture(), storage = await createInstalledNativeOutputStorage(f.input)
    const reservation = await storage.reserve(f.request), path = join(f.input.rootDirectory, f.request.artifactId)
    await writeFile(path, 'owned bytes', { mode: 0o600 })
    await expect(reservation.release()).rejects.toThrow()
    expect(f.release).not.toHaveBeenCalled()
    await unlink(path)
    vi.mocked(f.input.protection.assertQuiescent).mockRejectedValueOnce(new Error('Reader still active'))
    await expect(reservation.release()).rejects.toThrow('Reader still active')
    expect(f.release).not.toHaveBeenCalled()
    vi.mocked(f.input.assertCurrent).mockRejectedValue(new Error('Turn withdrawn'))
    await reservation.release()
    expect(f.release).toHaveBeenCalledTimes(1)
  })
  it('rejects writable parents, descendants, same directory and relative paths', () => {
    for (const roots of [['/'], ['/private'], ['/private/output'], ['/private/output/child'], ['relative']]) {
      expect(() => assertNativeOutputRootExcluded('/private/output', roots)).toThrow()
    }
    expect(() => assertNativeOutputRootExcluded('/private/output', ['/workspace', '/tmp'])).not.toThrow()
  })
})
