import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEVICE_APPLICATION_JSON_BYTES, negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { RemoteExecutionRpcRequestSchema, RemoteReceiptPageSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { DeviceApplicationChannel, extensionDescriptors,
  type DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../devices/deviceWire.js'
import { deriveDispatch, freezePlacement } from '../../placement/binding.js'
import { remoteNativeManager } from '../../placement/workerCarrier.js'
import { WorkerExecutionPolicy } from '../../settings/workerExecution.js'
import { input } from '../../../../test/fixtures/codex-test-helpers.js'
import { InstalledWorkflowResponsePages, readRemoteReceiptResponse } from './installedWorkflowResponsePages.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { pageNativeHistory } from './nativeHistoryPage.js'
import type { RemoteResultCommitPort } from './resultBridge.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  frames: string[] = []
  send(frame: string) {
    this.frames.push(frame)
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(frame), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

function fixture() {
  const start = input('/project')
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const binding = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const connection = DeviceConnectionIdentitySchema.strip().parse(binding)
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: start.request.runId,
    nodeId: start.request.workflowNodeId, hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: start.request.configuration.agentId,
      agentConfigurationVersionId: start.request.configuration.id, driverId: 'codex', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: start.request.executionId, occurrenceId: null,
    occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation',
    inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
  const native = { sessionId: session.nativeSessionId, turnId: 'native-turn', processIdentityDigest: digest }
  const result = { outcome: 'succeeded' as const, output: { text: '漢😀'.repeat(170_000) } }
  const correlationId = `execution:${intent.executionId}`
  const history = { events: [], pendingInteractions: [], nativeTurnId: native.turnId, correlationId,
    terminalTurn: { correlationId, providerId: native.turnId, result } }
  return { binding, connection, placement, intent, native, session, result, history, start, digest }
}

function carrier(f: ReturnType<typeof fixture>, journal: RemoteOperationJournal) {
  const pages = new InstalledWorkflowResponsePages()
  const methods: string[] = []
  let captures = 0
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const registration: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: 'server',
    maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0,
    handle: async (raw, context) => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      methods.push(frame.method)
      if (frame.method === 'receipt-continuation') return { payload: pages.read(frame, context.binding) }
      if (frame.method === 'renew-owner') await journal.reconcileOwner(frame.transition)
      const status = await journal.status(frame.intent.operationId)
      let payload: unknown = status
      if (frame.method === 'prepare' || frame.method === 'reattach') payload = { session: f.session, status }
      if (frame.method === 'history') payload = { ...pageNativeHistory(f.history, frame.afterSequence, frame.metadata), status }
      return { payload: pages.page(payload, frame, context.binding) }
    } }
  const client: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: 'client',
    maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0 }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([client]), extensionDescriptors([registration]))
  const parent = new AbortController()
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const main = new DeviceApplicationChannel({ side: 'main', binding: f.binding, socket: mainSocket,
    signal: parent.signal, extensions, registrations: [client], revalidate: async () => {} })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.binding, socket: workerSocket,
    signal: parent.signal, extensions, registrations: [registration] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 1000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
  for (const task of tasks) void task.catch(() => {})
  const committed: RemoteOperationReceipt[] = []
  const manager = remoteNativeManager({ harness: 'codex', agentId: f.start.request.configuration.agentId,
    executionId: f.intent.executionId, configuration: f.start.request.configuration, workingDirectory: '/project' },
  { intent: f.intent, placement: f.placement }, {
    workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
    carrier: { capture: () => {
      captures++
      return { identity: f.connection, request: main.request.bind(main) }
    } },
    beforePrepare: async () => {},
    controlFor: async () => { throw new Error('No native control is expected') },
    commit: async (receipt, authenticated, response) => {
      expect(authenticated).toEqual(f.connection)
      const status = (response as { status: unknown }).status
      expect(typeof status === 'string' ? response : status).toEqual({ status: 'known', receipt })
      const port: RemoteResultCommitPort = { transaction: async (_operationId, work) => work({
        authority: async () => ({ intent: receipt.intent, placement: f.placement,
          originalConnection: f.connection, originalIncarnationId: receipt.workerIncarnationId,
          grantIsLive: true, lastSequence: committed.at(-1)?.sequence ?? 0,
          lastReceipt: committed.at(-1) ?? null, native: f.native, terminal: null }),
        reject: async (_receipt, reason) => { throw new Error(`Rejected receipt: ${reason}`) },
        accept: async value => { committed.push(value.receipt) },
      }) }
      return port
    },
  })
  return { manager, methods, committed, captures: () => captures, rawMain, rawWorker,
    close: async () => {
      parent.abort()
      main.close()
      worker.close()
      await Promise.allSettled(tasks)
      pages.clear()
    } }
}

describe('installed workflow receipt transfer', () => {
  it.each(['terminal', 'retained reviewer'] as const)(
    'preserves a large %s receipt through the authenticated carrier and journal restart', async kind => {
      const f = fixture()
      const root = await mkdtemp(join(tmpdir(), 'workflow-receipt-transfer-'))
      const path = join(root, 'journal.json')
      let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
      let channel: ReturnType<typeof carrier> | undefined
      try {
        await journal.accept(f.intent, f.connection, randomUUID())
        await journal.reserveEntry(f.intent.operationId)
        await journal.acknowledgeStart(f.intent.operationId, f.native)
        await journal.reserveTurn(f.intent.operationId, { correlationId: f.history.correlationId, promptDigest: f.digest })
        await journal.acknowledgeTurn(f.intent.operationId, f.native.turnId)
        await journal.markRunning(f.intent.operationId)
        channel = carrier(f, journal)
        const start = { request: f.start.request, correlationId: f.history.correlationId }
        const session = await channel.manager.createSession(start)
        if (kind === 'terminal') {
          await journal.terminal(f.intent.operationId, { kind: 'completed', closureEvidenceDigest: f.digest, result: f.result })
        } else {
          await journal.retainReviewer(f.intent.operationId, { agentId: 'reviewer',
            expiresAt: '2099-01-01T00:00:00.000Z' }, f.history)
        }
        const status = await journal.status(f.intent.operationId)
        expect(Buffer.byteLength(JSON.stringify(status))).toBeGreaterThan(DEVICE_APPLICATION_JSON_BYTES)
        await channel.manager.observeBoundary(session)
        const stream = channel.manager.startTurn(session, { prompt: 'original prompt',
          clientCorrelationId: f.history.correlationId })
        expect((await stream.next()).done).toBe(true)
        expect((await channel.manager.reconcile(session, f.history.correlationId)).terminalTurn?.result).toEqual(f.result)
        if (kind === 'retained reviewer') {
          await channel.manager.renewOwner({ commandId: 'renewal', operationId: f.intent.operationId,
            previousOwner: f.intent.owner, nextOwner: { grantId: 'renewed', epoch: '2' },
            native: f.native, evidenceDigest: f.digest })
          f.intent = { ...f.intent, owner: { grantId: 'renewed', epoch: '2' } }
          expect(channel.manager.retainsReviewerSession).toBe(true)
        } else if (status.status === 'known') {
          await journal.retireSettled(f.intent, status.receipt.sequence)
          await channel.manager.observeBoundary(session)
        }
        expect(channel.methods.filter(method => method === 'prepare')).toHaveLength(1)
        expect(channel.methods.filter(method => method === 'start-turn')).toHaveLength(1)
        expect(channel.methods.filter(method => method === 'receipt-continuation').length).toBeGreaterThan(32)
        expect(channel.captures()).toBe(channel.methods.filter(method => method !== 'receipt-continuation').length)
        expect(channel.rawWorker.frames.every(frame => Buffer.byteLength(frame) <= 16_384)).toBe(true)
        expect(channel.rawMain.closed).toBe(false)
        await channel.close()
        channel = undefined
        await journal.close()
        journal = await RemoteOperationJournal.open(path)
        channel = carrier(f, journal)
        await channel.manager.attachSession(f.session, start)
        await channel.manager.observeBoundary(f.session)
        expect((await channel.manager.history(f.session)).terminalTurn?.result).toEqual(f.result)
        const latest = channel.committed.at(-1)!
        expect(latest.terminal?.result ?? latest.retainedReviewer?.result).toEqual(f.result)
        expect(channel.methods).not.toContain('prepare')
        expect(channel.methods).not.toContain('start-turn')
        expect(channel.rawMain.closed).toBe(false)
      } finally {
        await channel?.close()
        await journal.close()
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)

  it('fences receipt continuations by connection, owner, placement, sequence and digest', async () => {
    const f = fixture()
    const receipt = { schemaVersion: 1, intent: f.intent, connection: f.connection,
      workerIncarnationId: randomUUID(), sequence: 1, phase: 'confirmed_terminal', native: f.native,
      terminal: { kind: 'completed', closureEvidenceDigest: f.digest, result: f.result },
      entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] }
    const pages = new InstalledWorkflowResponsePages()
    const frame = RemoteExecutionRpcRequestSchema.parse({ method: 'status', intent: f.intent, placement: f.placement })
    const raw = pages.page({ status: 'known', receipt }, frame, f.binding) as { receipt: unknown }
    const first = RemoteReceiptPageSchema.parse(raw.receipt)
    const next = RemoteExecutionRpcRequestSchema.parse({ ...frame, method: 'receipt-continuation',
      transferId: first.transferId, receiptSequence: first.receiptSequence,
      metadata: { digest: first.metadata.digest, offset: Buffer.from(first.metadata.data, 'base64').byteLength } })
    if (next.method !== 'receipt-continuation') throw new Error('Wrong test request')
    expect(() => pages.read(next, { ...f.binding, connectionEpoch: randomUUID() })).toThrow('owner or revision')
    expect(() => pages.read({ ...next, intent: { ...next.intent, owner: { grantId: 'other', epoch: '2' } } },
      f.binding)).toThrow('owner or revision')
    expect(() => pages.read({ ...next, placement: { ...next.placement, nodeId: 'other' } }, f.binding)).toThrow('owner or revision')
    expect(() => pages.read({ ...next, receiptSequence: 2 }, f.binding)).toThrow('owner or revision')
    expect(() => pages.read({ ...next, metadata: { ...next.metadata, digest: 'b'.repeat(64) } },
      f.binding)).toThrow('JSON continuation changed')
    const hydrated = await readRemoteReceiptResponse(raw, f.intent,
      request => Promise.resolve(pages.read({ ...next, ...request }, f.binding)))
    expect(hydrated).toEqual({ status: 'known', receipt })
    expect(pages.read(next, f.binding).metadata.offset).toBe(next.metadata.offset)
    pages.clear()
    expect(() => pages.read(next, f.binding)).toThrow('owner or revision')
  })

  it('expires old snapshots and reuses the bounded retained byte window', () => {
    const f = fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const receipt = { schemaVersion: 1, intent: f.intent, connection: f.connection,
      workerIncarnationId: randomUUID(), sequence: 1, phase: 'confirmed_terminal', native: f.native,
      terminal: { kind: 'completed', closureEvidenceDigest: f.digest, result: f.result },
      entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] }
    const pages = new InstalledWorkflowResponsePages()
    const frame = RemoteExecutionRpcRequestSchema.parse({ method: 'status', intent: f.intent, placement: f.placement })
    const snapshot = () => {
      const response = pages.page({ status: 'known', receipt }, frame, f.binding) as { receipt: unknown }
      const first = RemoteReceiptPageSchema.parse(response.receipt)
      const request = RemoteExecutionRpcRequestSchema.parse({ ...frame, method: 'receipt-continuation',
        transferId: first.transferId, receiptSequence: first.receiptSequence,
        metadata: { digest: first.metadata.digest, offset: Buffer.from(first.metadata.data, 'base64').byteLength } })
      if (request.method !== 'receipt-continuation') throw new Error('Wrong test request')
      return request
    }
    try {
      const oldest = snapshot()
      let latest = oldest
      for (let index = 0; index < 40; index++) latest = snapshot()
      expect(() => pages.read(oldest, f.binding)).toThrow('owner or revision')
      expect(pages.read(latest, f.binding).metadata.offset).toBe(latest.metadata.offset)
      clock.mockReturnValue(121_001)
      expect(() => pages.read(latest, f.binding)).toThrow('owner or revision')
      const renewed = snapshot()
      expect(pages.read(renewed, f.binding).metadata.offset).toBe(renewed.metadata.offset)
    } finally {
      pages.clear()
      clock.mockRestore()
    }
  })
})
