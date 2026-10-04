import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteOperationJournal } from './operationJournal.js'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOwnerControl, RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
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
  it('enters Stop delivery for the acknowledged review turn while preserving the original workflow identity', async () => {
    const { journal } = await setup()
    await journal.accept(intent, connection, randomUUID())
    await journal.reserveEntry(intent.operationId)
    await journal.acknowledgeStart(intent.operationId, native)
    await journal.reserveTurn(intent.operationId, { correlationId: 'execution:execution', promptDigest: digest })
    await journal.acknowledgeTurn(intent.operationId, native.turnId)
    await journal.markRunning(intent.operationId)
    await journal.retainReviewer(intent.operationId, { agentId: 'reviewer', expiresAt: '2099-01-01T00:00:00.000Z' },
      { events: [], pendingInteractions: [], nativeTurnId: native.turnId,
        terminalTurn: { correlationId: 'execution:execution', providerId: native.turnId,
          result: { outcome: 'succeeded' } } })
    const assignment = { jobId: 'review-job', interactionId: 'interaction', reviewerAgentId: 'reviewer',
      correlationId: 'review:review-job', session: { harness: 'codex' as const,
        providerVersion: '0.154.0', nativeSessionId: native.sessionId } }
    await journal.reserveReviewTurn(intent.operationId, assignment, digest, -1)
    await journal.enterReviewTurn(intent.operationId, assignment.correlationId)
    await journal.acknowledgeReviewTurn(intent.operationId, assignment.correlationId, 'review-turn')
    await expect(journal.control({ ...stop, commandId: 'stale-workflow-stop', native })).rejects.toThrow('target')
    const command = { ...stop, native: { ...native, turnId: 'review-turn' },
      nativeTarget: { kind: 'session' as const, sessionId: native.sessionId, turnId: 'review-turn' } }
    expect((await journal.control(command)).dispatch).toBe(true)
    expect(await journal.enterControlDelivery(command)).toBe(true)
    await journal.acknowledgeControl(command)
    expect(await journal.enterControlDelivery(command)).toBe(false)
    expect(await journal.status(intent.operationId)).toMatchObject({ status: 'known', receipt: {
      native, stopFence: true, reviewTurns: [{ providerId: 'review-turn' }],
    } })
  })

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
    const retained = await Promise.all((await readdir(dirname(path))).map(name => readFile(join(dirname(path), name), 'utf8')))
    expect(retained).toContain(JSON.stringify(owner))
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
  it('reuses settled capacity while retaining immutable readback and duplicate ownership fences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'journal-retention-'))
    roots.push(root)
    const path = join(root, 'journal.json')
    const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true, capacity: 1 })
    journals.push(journal)
    const evidence = { kind: 'completed' as const, closureEvidenceDigest: digest,
      result: { outcome: 'succeeded' as const, output: { text: 'x'.repeat(24_000) } } }
    let original: RemoteOperationReceipt | undefined
    for (let index = 0; index < 4; index++) {
      const dispatched = { ...intent, operationId: `operation-${index}`,
        executionId: `execution-${index}`, attemptId: `attempt-${index}` }
      await journal.accept(dispatched, connection, randomUUID())
      await journal.reserveEntry(dispatched.operationId)
      await journal.acknowledgeStart(dispatched.operationId, native)
      await expect(journal.accept({ ...intent, operationId: 'excess' }, connection, randomUUID()))
        .rejects.toThrow('full')
      const cancel = { ...stop, commandId: `stop-${index}`, operationId: dispatched.operationId,
        attemptId: dispatched.attemptId, executionId: dispatched.executionId }
      expect((await journal.control(cancel)).dispatch).toBe(true)
      expect(await journal.enterControlDelivery(cancel)).toBe(true)
      await journal.acknowledgeControl(cancel)
      const terminal = await journal.terminal(dispatched.operationId, evidence)
      await expect(journal.retireSettled({ ...dispatched, owner: { grantId: 'foreign', epoch: '1' } }, terminal.sequence))
        .rejects.toThrow('retirement required')
      await journal.retireSettled(dispatched, terminal.sequence)
      if (index === 0) original = terminal
    }
    if (!original) throw new Error('Missing first terminal receipt')
    await journal.close()
    const recovered = await RemoteOperationJournal.open(path, { capacity: 1 })
    journals.push(recovered)
    expect(await recovered.status(original.intent.operationId)).toEqual({ status: 'known', receipt: original })
    expect(await recovered.accept(original.intent, connection, randomUUID())).toEqual(original)
    expect((await recovered.reserveEntry(original.intent.operationId)).reserved).toBe(false)
    const duplicate = original.controls[0]!
    expect((await recovered.control(duplicate)).dispatch).toBe(false)
    await expect(recovered.control({ ...duplicate, native: { ...native, sessionId: 'changed' } }))
      .rejects.toThrow('Control command conflict')
    await expect(recovered.accept({ ...original.intent, operationId: 'replacement' }, connection, randomUUID()))
      .rejects.toThrow('already bound')
    await expect(recovered.control({ ...stop, operationId: original.intent.operationId,
      attemptId: original.intent.attemptId, executionId: original.intent.executionId,
      native: { ...native, sessionId: 'foreign' } })).rejects.toThrow('Wrong native')
    expect((await recovered.control({ ...stop, operationId: original.intent.operationId,
      attemptId: original.intent.attemptId, executionId: original.intent.executionId })).dispatch).toBe(false)
    await recovered.accept(intent, connection, randomUUID())
  })
  it('rejects byte exhaustion before disk uncertainty and preserves Stop for another active owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'journal-bytes-'))
    roots.push(root)
    const journal = await RemoteOperationJournal.open(join(root, 'journal.json'), {
      initializeNewInstallation: true, capacity: 3, byteLimit: 16 * 1024,
    })
    journals.push(journal)
    const other = { ...intent, operationId: 'other', executionId: 'other-execution', attemptId: 'other-attempt' }
    await journal.accept(intent, connection, randomUUID())
    await journal.accept(other, connection, randomUUID())
    await journal.reserveEntry(intent.operationId)
    await journal.acknowledgeStart(intent.operationId, native)
    await journal.reserveEntry(other.operationId)
    await journal.acknowledgeStart(other.operationId, { ...native, sessionId: 'other-session' })
    await expect(journal.terminal(intent.operationId, { kind: 'completed', closureEvidenceDigest: digest,
      result: { outcome: 'succeeded', output: { text: 'x'.repeat(16_384) } } })).rejects.toThrow('byte limit')
    expect(await journal.status(intent.operationId)).toMatchObject({
      status: 'known', receipt: { phase: 'start_acknowledged', native },
    })
    const terminal = await journal.terminal(intent.operationId, { kind: 'completed', closureEvidenceDigest: digest,
      result: { outcome: 'succeeded', output: { text: 'x'.repeat(9_000) } } })
    const third = { ...intent, operationId: 'third', executionId: 'third-execution', attemptId: 'third-attempt' }
    await expect(journal.accept(third, connection, randomUUID())).rejects.toThrow('byte limit')
    const cancel = { ...stop, operationId: other.operationId, attemptId: other.attemptId, executionId: other.executionId }
    expect((await journal.control(cancel)).dispatch).toBe(true)
    expect(await journal.enterControlDelivery(cancel)).toBe(true)
    await journal.acknowledgeControl(cancel)
    expect(await journal.status(other.operationId)).toMatchObject({
      status: 'known', receipt: { phase: 'stop_requested', stopFence: true },
    })
    await journal.retireSettled(intent, terminal.sequence)
    await journal.accept(third, connection, randomUUID())
    expect(await journal.status(intent.operationId)).toEqual({ status: 'known', receipt: terminal })
  })
  it('rejects retirement before terminal closure and old-owner delivery after renewal', async () => {
    const { journal } = await setup()
    const receipt = await journal.accept(intent, connection, randomUUID())
    await expect(journal.retireSettled(intent, receipt.sequence)).rejects.toThrow('terminal retirement required')
    await journal.reserveEntry(intent.operationId)
    await journal.acknowledgeStart(intent.operationId, native)
    await journal.control(stop)
    await journal.reconcileOwner({ commandId: 'renew', operationId: intent.operationId,
      previousOwner: intent.owner, nextOwner: { grantId: 'renewed', epoch: '2' }, native, evidenceDigest: digest })
    await expect(journal.enterControlDelivery(stop)).rejects.toThrow('Stale control ownership')
  })
})
