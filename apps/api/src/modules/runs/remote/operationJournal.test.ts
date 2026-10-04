import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteOperationJournal } from './operationJournal.js'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import { bootIdentity, processIdentity, identityAlive } from '../../harnesses/recovery/linuxIdentity.js'
const roots: string[] = []
const journals: RemoteOperationJournal[] = []
afterEach(async () => { await Promise.all(journals.splice(0).map(journal => journal.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const digest = 'a'.repeat(64)
const intent: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(), runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: 'occurrence', occurrenceIndex: 0, technicalAttempt: 1,
  attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } }
const connection = { mainId: intent.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
const native = { sessionId: 'session', turnId: 'turn', processIdentityDigest: digest }
const stop: RemoteOwnerControl = { schemaVersion: 1, protocolVersion: 1, commandId: 'stop', operationId: 'operation', attemptId: 'attempt', executionId: 'execution', bindingHash: digest, owner: intent.owner, action: { kind: 'stop' } }
async function setup() { const root = await mkdtemp(join(tmpdir(), 'w08-journal-')); roots.push(root); const path = join(root, 'journal.json'); const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true }); journals.push(journal); return { path, journal } }
describe('durable remote ownership', () => {
  it('duplicate delivery and concurrent reservations authorize one entry', async () => {
    const { journal } = await setup()
    const receipt = await journal.accept(intent, connection, randomUUID())
    expect(await journal.accept(intent, connection, randomUUID())).toEqual(receipt)
    const reservations = await Promise.all([journal.reserveEntry('operation'), journal.reserveEntry('operation')])
    expect(reservations.filter(value => value.reserved)).toHaveLength(1)
    await expect(journal.accept({ ...intent, bindingHash: 'b'.repeat(64) }, connection, randomUUID())).rejects.toThrow('binding conflict')
  })
  it('rejects a different operation ID for the same immutable execution attempt', async () => { const { journal } = await setup(); await journal.accept(intent, connection, randomUUID()); await expect(journal.accept({ ...intent, operationId: 'replacement-operation' }, connection, randomUUID())).rejects.toThrow('already bound') })
  it('reopens receipt/entry/provider acceptance without automatically reentering', async () => {
    const { path, journal } = await setup()
    await journal.accept(intent, connection, randomUUID()); await journal.reserveEntry('operation')
    await journal.close(); let recovered = await RemoteOperationJournal.open(path); journals.push(recovered)
    expect((await recovered.reserveEntry('operation')).reserved).toBe(false)
    await recovered.uncertain('operation', 'start acknowledgment lost')
    expect((await recovered.reserveEntry('operation')).reserved).toBe(false)
    await recovered.acknowledgeStart('operation', native)
    await recovered.confirmRecovered('operation', native)
    expect((await recovered.reserveEntry('operation')).reserved).toBe(false)
    await recovered.close(); recovered = await RemoteOperationJournal.open(path); journals.push(recovered)
    expect((await recovered.status('operation')).status).toBe('known')
    expect((await recovered.reserveEntry('operation')).reserved).toBe(false)
  })
  it('Stop before Start durably fences delayed delivery and separates requested from closed', async () => {
    const { path, journal } = await setup()
    await journal.accept(intent, connection, randomUUID())
    const result = await journal.control(stop)
    expect(result.receipt.phase).toBe('stop_requested'); expect(result.dispatch).toBe(false)
    await journal.close(); const recovered = await RemoteOperationJournal.open(path); journals.push(recovered); journals.push(recovered)
    expect((await recovered.reserveEntry('operation')).reserved).toBe(false)
    await recovered.terminal('operation', { kind: 'not_started', closureEvidenceDigest: digest })
    expect((await recovered.control(stop)).dispatch).toBe(false)
  })
  it('entry-before-Stop cannot claim nonexecution; a late provider ACK retains Stop', async () => {
    const { journal } = await setup(); await journal.accept(intent, connection, randomUUID())
    await journal.reserveEntry('operation'); await journal.control(stop)
    await expect(journal.terminal('operation', { kind: 'not_started', closureEvidenceDigest: digest })).rejects.toThrow('not proven')
    expect((await journal.acknowledgeStart('operation', native)).phase).toBe('stop_requested')
    await journal.terminal('operation', { kind: 'cancelled', closureEvidenceDigest: digest })
  })
  it('rejects stale/wrong-session controls and converges duplicate terminal reports', async () => {
    const { journal } = await setup(); await journal.accept(intent, connection, randomUUID()); await journal.reserveEntry('operation'); await journal.acknowledgeStart('operation', native); await journal.markRunning('operation')
    await expect(journal.control({ ...stop, owner: { grantId: 'old', epoch: '1' } })).rejects.toThrow('Stale')
    await expect(journal.control({ ...stop, native: { ...native, turnId: 'other' } })).rejects.toThrow('Wrong native')
    const evidence = { kind: 'completed' as const, closureEvidenceDigest: digest, resultDigest: digest }
    const receipt = await journal.terminal('operation', evidence)
    expect(await journal.terminal('operation', evidence)).toEqual(receipt)
    await expect(journal.terminal('operation', { ...evidence, resultDigest: 'b'.repeat(64) })).rejects.toThrow('Conflicting')
  })
  it('one installation journal cannot be opened by concurrent worker owners', async () => {
    const { path, journal } = await setup()
    await expect(RemoteOperationJournal.open(path)).rejects.toMatchObject({ code: 'EEXIST' })
    await journal.accept(intent, connection, randomUUID())
  })
  it('respond reserves one exact native question and rejects stale/replacement questions', async () => {
    const { journal } = await setup(); await journal.accept(intent, connection, randomUUID()); await journal.reserveEntry('operation'); await journal.acknowledgeStart('operation', native); await journal.markRunning('operation')
    await journal.interaction('operation', { interactionId: 'question', interactionRevision: '2', nativeInteractionId: 'native-question', native })
    const response: RemoteOwnerControl = { ...stop, commandId: 'respond', native, action: { kind: 'respond', interactionId: 'question', interactionRevision: '2', nativeInteractionId: 'native-question', response: { answer: 'yes' } } }
    await expect(journal.control({ ...response, action: { ...response.action, kind: 'respond', interactionId: 'question', interactionRevision: '1', nativeInteractionId: 'native-question', response: {} } })).rejects.toThrow('not currently eligible')
    expect((await journal.control(response)).dispatch).toBe(true)
    expect((await journal.control(response)).dispatch).toBe(false)
    await expect(journal.control({ ...response, commandId: 'another-command' })).rejects.toThrow('already reserved')
    await journal.interaction('operation', { interactionId: 'question', interactionRevision: '3', nativeInteractionId: 'native-question', native })
    await expect(journal.control({ ...response, commandId: 'new-revision', action: { kind: 'respond', interactionId: 'question', interactionRevision: '3', nativeInteractionId: 'native-question', response: {} } })).rejects.toThrow('already reserved')
  })
  it('absence, corruption and capacity exhaustion never authorize replacement work', async () => {
    const { path, journal } = await setup(); expect(await journal.status('missing')).toEqual({ status: 'unknown', reason: 'journal_absence_requires_reconciliation' })
    await expect(RemoteOperationJournal.open(`${path}.missing`)).rejects.toThrow('recovery required')
    await journal.close(); await writeFile(path, '{broken'); await expect(RemoteOperationJournal.open(path)).rejects.toThrow('recovery required')
    const other = await RemoteOperationJournal.open(`${path}.bounded`, { initializeNewInstallation: true, capacity: 1 })
    journals.push(other); await other.accept(intent, connection, randomUUID())
    await expect(other.accept({ ...intent, operationId: 'other', executionId: 'other-execution', attemptId: 'other-attempt' }, connection, randomUUID())).rejects.toThrow('full')
  })
  it('audits explicit original-execution owner renewal without granting another entry', async () => {
    const { journal } = await setup(); await journal.accept(intent, connection, randomUUID()); await journal.reserveEntry('operation'); await journal.acknowledgeStart('operation', native)
    const transition = { commandId: 'renew', operationId: 'operation', previousOwner: intent.owner, nextOwner: { grantId: 'renewed', epoch: '2' }, native, evidenceDigest: digest }
    const receipt = await journal.reconcileOwner(transition)
    expect(receipt.intent.owner.epoch).toBe('2'); expect(await journal.reconcileOwner(transition)).toEqual(receipt)
    expect((await journal.reserveEntry('operation')).reserved).toBe(false)
  })
  it('persists reserved controls separately from native entry and acknowledgement', async () => {
    const { path, journal } = await setup()
    await journal.accept(intent, connection, randomUUID())
    await journal.reserveEntry(intent.operationId)
    await journal.acknowledgeStart(intent.operationId, native)
    await journal.control(stop)
    await journal.close()
    const recovered = await RemoteOperationJournal.open(path)
    journals.push(recovered)
    expect(await recovered.controlDelivery(stop)).toBe('reserved')
    const entries = await Promise.all([
      recovered.enterControlDelivery(stop), recovered.enterControlDelivery(stop),
    ])
    expect(entries.filter(Boolean)).toHaveLength(1)
    await recovered.close()
    const entered = await RemoteOperationJournal.open(path)
    journals.push(entered)
    expect(await entered.controlDelivery(stop)).toBe('entered')
    expect(await entered.enterControlDelivery(stop)).toBe(false)
    await entered.acknowledgeControl(stop)
    expect(await entered.controlDelivery(stop)).toBe('acknowledged')
    expect(await entered.enterControlDelivery(stop)).toBe(false)
  })
  it('recovers a killed service while fencing its surviving native descendant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'journal-crash-'))
    roots.push(root)
    const path = join(root, 'journal.json')
    const moduleUrl = new URL('./operationJournal.ts', import.meta.url).href
    const script = `
      import { spawn } from 'node:child_process';
      import { RemoteOperationJournal } from ${JSON.stringify(moduleUrl)};
      const journal = await RemoteOperationJournal.open(process.argv[1], { initializeNewInstallation: true });
      await journal.accept(${JSON.stringify(intent)}, ${JSON.stringify(connection)}, ${JSON.stringify(randomUUID())});
      await journal.reserveEntry('operation');
      await journal.acknowledgeStart('operation', ${JSON.stringify(native)});
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      descendant.unref();
      process.send(descendant.pid);
      setInterval(() => {}, 1000);
    `
    const worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    let descendantPid: number | undefined
    try {
      const pid = await new Promise<unknown>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', () => reject(new Error('Journal worker exited before reporting its descendant')))
      })
      descendantPid = Number(pid)
      const descendant = processIdentity(descendantPid)
      expect(descendant).toBeDefined()
      const killed = once(worker, 'exit')
      worker.kill('SIGKILL')
      await killed
      const recovered = await RemoteOperationJournal.open(path)
      journals.push(recovered)
      expect(descendant && identityAlive(descendant)).toBe(true)
      expect(await recovered.status(intent.operationId)).toMatchObject({
        status: 'known', receipt: { native, phase: 'start_acknowledged', entryAttempted: true },
      })
      expect((await recovered.reserveEntry(intent.operationId)).reserved).toBe(false)
      await expect(recovered.accept({ ...intent, operationId: 'replacement' }, connection, randomUUID()))
        .rejects.toThrow('already bound')
      expect((await readdir(root)).filter(name => name.includes('.retired-owner-'))).toHaveLength(1)
    } finally {
      worker.kill('SIGKILL')
      if (descendantPid) process.kill(descendantPid, 'SIGKILL')
    }
  })
  it('reconciles a prior boot service lock without promoting native ownership to closed', async () => {
    const { path, journal } = await setup()
    await journal.accept(intent, connection, randomUUID())
    await journal.reserveEntry(intent.operationId)
    await journal.acknowledgeStart(intent.operationId, native)
    await journal.close()
    const service = processIdentity(process.pid)!
    const owner = { version: 1, ownerId: randomUUID(), bootId: randomUUID(),
      pid: service.pid, startTicks: service.startTicks }
    expect(owner.bootId).not.toBe(bootIdentity())
    await writeFile(`${path}.owner-lock`, JSON.stringify(owner), { mode: 0o600 })
    const recovered = await RemoteOperationJournal.open(path)
    journals.push(recovered)
    expect(await recovered.status(intent.operationId)).toMatchObject({
      status: 'known', receipt: { native, phase: 'start_acknowledged' },
    })
    expect((await recovered.reserveEntry(intent.operationId)).reserved).toBe(false)
    expect(JSON.parse(await readFile(`${path}.retired-owner-${owner.ownerId}.json`, 'utf8'))).toEqual(owner)
  })
  it('refuses a live service identity or unidentifiable legacy lock even without a kernel holder', async () => {
    const { path, journal } = await setup()
    await journal.close()
    const service = processIdentity(process.pid)!
    await writeFile(`${path}.owner-lock`, JSON.stringify({ version: 1, ownerId: randomUUID(),
      bootId: bootIdentity(), pid: service.pid, startTicks: service.startTicks }))
    await expect(RemoteOperationJournal.open(path)).rejects.toMatchObject({ code: 'EEXIST' })
    await writeFile(`${path}.owner-lock`, randomUUID())
    await expect(RemoteOperationJournal.open(path)).rejects.toThrow()
    expect(await readFile(`${path}.owner-lock`, 'utf8')).toMatch(/^[a-f0-9-]{36}$/)
  })
})
