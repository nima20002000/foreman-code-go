import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rename, rm, writeFile, unlink, readFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { DeviceSessionBindingSchema } from '@foreman-code/contracts/device-connection'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { createInstalledNativeOutputStorage, assertNativeOutputRootExcluded, createNativeOutputBudgetLedger,
  type InstalledNativeOutputStorageInput } from './installedNativeOutputStorage.js'
import { ensureInstalledWorkflowOutputStore } from './installedWorkflowNativeOutputs.js'

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

async function startupFixture() {
  const f = await fixture()
  const binding = f.input.owner.binding
  const pairing = { ...binding, formatVersion: 1 as const, endpoint: 'wss://unit.invalid/device',
    mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
  const installation = { mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId }
  const limits = { maxDiskBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
    maxSnapshotBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
    maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal }
  const open = () => createNativeOutputBudgetLedger({
    rootDirectory: join(f.root, 'workflow-native-outputs', 'budget'), installation, limits })
  return { ...f, pairing, limits, open }
}

describe('worker startup output store', () => {
  it('creates an upgrade store automatically and preserves outstanding budgets on repeated startup', async () => {
    const f = await startupFixture()
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    const original = { owner: f.input.owner, artifactId: randomUUID(), limits: f.limits, requested: f.limits }
    await (await f.open()).reserve(original)
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    const recovered = await f.open()
    await (await recovered.reserve(original)).assertCurrent()
    await expect(recovered.reserve({ ...original, artifactId: randomUUID() })).rejects.toThrow()
  })

  it('rejects another installation and an exposed marker before using the established store', async () => {
    const f = await startupFixture()
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    await expect(ensureInstalledWorkflowOutputStore(f.root,
      { ...f.pairing, workerInstallationId: randomUUID() })).rejects.toMatchObject({
      code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
    await chmod(join(f.root, 'workflow-native-outputs-initialized.json'), 0o644)
    await expect(ensureInstalledWorkflowOutputStore(f.root, f.pairing)).rejects.toMatchObject({
      code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
  })

  it('requires recovery for missing established budget state instead of resetting outstanding charges', async () => {
    const f = await startupFixture()
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    await rm(join(f.root, 'workflow-native-outputs', 'budget', '.native-output-budget.json'))
    await expect(ensureInstalledWorkflowOutputStore(f.root, f.pairing)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(join(f.root, 'workflow-native-outputs'), { recursive: true })
    await expect(ensureInstalledWorkflowOutputStore(f.root, f.pairing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves pre-existing output state that has no installation marker', async () => {
    const f = await startupFixture()
    const directory = join(f.root, 'workflow-native-outputs')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'unreconciled'), 'retained bytes', { mode: 0o600 })
    await expect(ensureInstalledWorkflowOutputStore(f.root, f.pairing)).rejects.toMatchObject({
      code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
    expect(await readFile(join(directory, 'unreconciled'), 'utf8')).toBe('retained bytes')
  })
})

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

describe('durable native output installation budget, no qualification grants', () => {
  it('recovers exact reservations and enforces aggregate caps across turns and ledger instances', async () => {
    const f = await fixture(), owner = f.input.owner, binding = owner.binding
    const rootDirectory = join(f.root, 'budget'); await mkdir(rootDirectory, { mode: 0o700 })
    const installation = { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId }
    const limits = { maxDiskBytes: 8, maxSnapshotBytes: 8, maxCommandRecords: 2 }
    const requested = { maxDiskBytes: 6, maxSnapshotBytes: 6, maxCommandRecords: 1 }
    const ledger = await createNativeOutputBudgetLedger({ rootDirectory, installation, limits, initializeNewStore: true })
    const original = { artifactId: randomUUID(), owner, limits, requested }
    const reservation = await ledger.reserve(original)
    const before = await readFile(join(rootDirectory, '.native-output-budget.json'), 'utf8')
    const recovered = await createNativeOutputBudgetLedger({ rootDirectory, installation, limits })
    await (await recovered.reserve(original)).assertCurrent()
    expect(await readFile(join(rootDirectory, '.native-output-budget.json'), 'utf8')).toBe(before)
    await expect(recovered.reserve({ ...original, artifactId: randomUUID(), owner: { ...owner, nativeTurnId: 'another-turn' } })).rejects.toThrow()
    await expect(recovered.reserve({ ...original, owner: { ...owner, nativeTurnId: 'foreign-turn' } })).rejects.toThrow()
    await reservation.release(); await reservation.release()
    await expect(reservation.assertCurrent()).rejects.toThrow()
    await recovered.reserve({ ...original, artifactId: randomUUID() })
  })
  it('never initializes over pre-existing residue or steals a crash-left lock', async () => {
    const f = await fixture(), binding = f.input.owner.binding, rootDirectory = join(f.root, 'budget')
    await mkdir(rootDirectory, { mode: 0o700 })
    const input = { rootDirectory, installation: { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId },
      limits: { maxDiskBytes: 8, maxSnapshotBytes: 8, maxCommandRecords: 2 } }
    await expect(createNativeOutputBudgetLedger(input)).rejects.toMatchObject({ code: 'ENOENT' })
    const residue = join(rootDirectory, 'unreconciled'); await writeFile(residue, 'original bytes', { mode: 0o600 })
    await expect(createNativeOutputBudgetLedger({ ...input, initializeNewStore: true })).rejects.toThrow()
    await unlink(residue)
    const ledger = await createNativeOutputBudgetLedger({ ...input, initializeNewStore: true })
    await mkdir(join(rootDirectory, '.native-output-budget.lock'), { mode: 0o700 })
    await expect(ledger.reserve({ owner: f.input.owner, artifactId: randomUUID(), limits: input.limits,
      requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } })).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
