import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rename, rm, writeFile, unlink, readFile, chmod, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { DeviceSessionBindingSchema } from '@foreman-code/contracts/device-connection'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { createInstalledNativeOutputStorage, assertNativeOutputRootExcluded, createNativeOutputBudgetLedger,
  type InstalledNativeOutputStorageInput } from './installedNativeOutputStorage.js'
import { ensureInstalledWorkflowOutputStore } from './installedWorkflowNativeOutputs.js'
import { acquireNativeOutputBudgetLock } from './nativeOutputBudgetLock.js'
import { openPrivateRoot } from '../../sources/privateFilesystem.js'

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
  it.each(['marker', 'root', 'budget', 'turns', 'budget-write', 'budget-saved', 'completion-write'])(
    'resumes interrupted initialization after %s without replacing a completed budget', async boundary => {
      const f = await startupFixture()
      const installation = { mainId: f.pairing.mainId, deviceId: f.pairing.deviceId,
        workerInstallationId: f.pairing.workerInstallationId }
      const marker = join(f.root, 'workflow-native-outputs-initialized.json')
      await writeFile(marker, JSON.stringify({ version: 1, installation, phase: 'initializing' }), { mode: 0o600 })
      const directory = join(f.root, 'workflow-native-outputs')
      const stages = ['marker', 'root', 'budget', 'turns', 'budget-write', 'budget-saved', 'completion-write']
      const completed = stages.indexOf(boundary)
      if (completed >= 1) await mkdir(directory, { mode: 0o700 })
      if (completed >= 2) await mkdir(join(directory, 'budget'), { mode: 0o700 })
      if (completed >= 3) await mkdir(join(directory, 'turns'), { mode: 0o700 })
      if (boundary === 'budget-write') {
        await writeFile(join(directory, 'budget', `.native-output-budget-${randomUUID()}.tmp`),
          '{"checksum":', { mode: 0o600 })
      }
      const original = { owner: f.input.owner, artifactId: randomUUID(), limits: f.limits, requested: f.limits }
      if (completed >= 5) {
        const ledger = await createNativeOutputBudgetLedger({ rootDirectory: join(directory, 'budget'),
          installation, limits: f.limits, initializeNewStore: true })
        await ledger.reserve(original)
      }
      if (boundary === 'completion-write') {
        await writeFile(join(f.root, `.workflow-native-outputs-initialized.json-${randomUUID()}.tmp`),
          '{"version":1', { mode: 0o600 })
      }
      await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
      expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ version: 1, installation, phase: 'complete' })
      const ledger = await f.open()
      await (await ledger.reserve(original)).assertCurrent()
      await expect(ledger.reserve({ ...original, artifactId: randomUUID() })).rejects.toThrow()
    })

  it('recovers the previous marker-before-directories crash only before native ownership was recorded', async () => {
    const f = await startupFixture()
    const installation = { mainId: f.pairing.mainId, deviceId: f.pairing.deviceId,
      workerInstallationId: f.pairing.workerInstallationId }
    await writeFile(join(f.root, 'workflow-native-outputs-initialized.json'),
      JSON.stringify(installation), { mode: 0o600 })
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    const ledger = await f.open()
    await ledger.reserve({ owner: f.input.owner, artifactId: randomUUID(), limits: f.limits, requested: f.limits })
    const retained = await startupFixture()
    await writeFile(join(retained.root, 'workflow-native-outputs-initialized.json'), JSON.stringify({
      mainId: retained.pairing.mainId, deviceId: retained.pairing.deviceId,
      workerInstallationId: retained.pairing.workerInstallationId }), { mode: 0o600 })
    await mkdir(join(retained.root, 'workflow-native-processes'), { mode: 0o700 })
    await expect(ensureInstalledWorkflowOutputStore(retained.root, retained.pairing)).rejects.toMatchObject({
      code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
  })

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
  it('preserves pre-existing residue and requires stopped-worker ownership to upgrade an unowned legacy lock', async () => {
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
      requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } })).rejects.toMatchObject({
      code: 'WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE' })
    const recovered = await createNativeOutputBudgetLedger({ ...input, stoppedWorker: true })
    await recovered.reserve({ owner: f.input.owner, artifactId: randomUUID(), limits: input.limits,
      requested: { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 } })
    expect((await readdir(rootDirectory)).some(name => name.startsWith('.native-output-budget-retired-lock-'))).toBe(true)
  })

  it('serializes overlapping producers, readers and releases across ledger instances without losing charges', async () => {
    const f = await startupFixture()
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    const first = await f.open()
    const second = await f.open()
    const requested = { maxDiskBytes: 1, maxSnapshotBytes: 1, maxCommandRecords: 1 }
    const originals = Array.from({ length: 8 }, (_, index) => ({ owner: { ...f.input.owner,
      nativeTurnId: `producer-${index}` }, artifactId: randomUUID(), limits: f.limits, requested }))
    const reservations = await Promise.all(originals.map((original, index) =>
      (index % 2 ? first : second).reserve(original)))
    await Promise.all(reservations.map(reservation => reservation.assertCurrent()))
    const journal = JSON.parse(await readFile(join(f.root, 'workflow-native-outputs', 'budget',
      '.native-output-budget.json'), 'utf8'))
    expect(journal.payload.records).toHaveLength(8)
    expect(journal.payload.records.every((record: { released: boolean }) => !record.released)).toBe(true)
    await Promise.all(reservations.map(reservation => reservation.release()))
    await Promise.all(reservations.map(reservation => expect(reservation.assertCurrent()).rejects.toThrow()))
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    const recovered = await f.open()
    await recovered.reserve({ owner: f.input.owner, artifactId: randomUUID(), limits: f.limits, requested: f.limits })
  })

  it('cancels queued transactions before charging and permits subsequent producers', async () => {
    const f = await startupFixture()
    await ensureInstalledWorkflowOutputStore(f.root, f.pairing)
    const ledger = await f.open()
    const root = await openPrivateRoot(join(f.root, 'workflow-native-outputs', 'budget'))
    const held = await acquireNativeOutputBudgetLock(root)
    const abort = new AbortController()
    const original = { owner: f.input.owner, artifactId: randomUUID(), limits: f.limits, requested: f.limits }
    try {
      const blocked = ledger.reserve(original, abort.signal)
      const rejected = expect(blocked).rejects.toThrow()
      abort.abort(new Error('Producer cancelled'))
      await rejected
      const journal = JSON.parse(await readFile(join(f.root, 'workflow-native-outputs', 'budget',
        '.native-output-budget.json'), 'utf8'))
      expect(journal.payload.records).toEqual([])
    } finally {
      await held.close()
      await root.close()
    }
    await (await ledger.reserve(original)).assertCurrent()
  })
})
