import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentFilePublishInput } from '@foreman-code/contracts/files'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import type { TransferContext, TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { TemporaryFileService } from '../../files/service.js'
import { FileByteStorage } from '../../files/storage.js'
import { DistributedArtifactPublicationService, type AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { WorkerNativeOutputRegistry } from './workerNativeOutputRegistry.js'
import { WorkerNativeArtifactSender, type WorkerNativeArtifactApplication } from './workerNativeArtifactSender.js'
import Fastify from 'fastify'
import { isDeepStrictEqual } from 'node:util'
import type { ArtifactEdgeBinding } from '@graphql/contracts/artifact-edges'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@graphql/contracts/device-identity'
import { WorkerMcpRelayRequestSchema } from '@graphql/contracts/worker-mcp-relay'
import type { CodexNativeOutputQualificationInput, CodexNativeOutputTurnPin } from '../../harnesses/codexNativeOutput.js'
import { ArtifactEdgeService } from '../../files/distributed/edges.js'
import { registerDistributedArtifacts } from '../../files/distributed/adapters.js'
import { CanonicalNativeArtifactResults } from '../../files/distributed/nativeResults.js'
import { NativeArtifactOutputs, type WorkflowNativeArtifactOutput } from './nativeArtifactOutputs.js'
import { DomainError } from '../../errors.js'
import { createInstalledNativeOutputs } from './installedNativeOutput.js'
import { createInstalledWorkflowNativeOutputFactory, ensureInstalledWorkflowOutputStore } from './installedWorkflowNativeOutputs.js'
import type { InstalledWorkflowNativeOutputContext } from './installedWorkflowHost.js'
import { WorkflowNativeArtifactResults } from './workflowNativeArtifactResults.js'

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Synthetic accepted placement/admission/native callback/sandbox/budget ports ONLY.
// Real files, registry, sender, receiver, canonical FileByteStorage/publication
// are exercised. No fixture claims DB, authenticated endpoint or native evidence.
async function fixture(body = Buffer.from('# tool-created workflow output\n'), chunkBytes = 4) {
  // Avoid the scheduler's group-writable TMPDIR ancestors. This actual Linux
  // sticky-/tmp child is owned 0700 and still uses the full root qualifier.
  const f = await fileToolFixture(), root = await mkdtemp('/tmp/worker-native-sender-test-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  // Main canonical storage deliberately excludes /tmp; keep its real byte store
  // in a separate owned directory, rather than weakening that storage boundary.
  const canonicalRoot = await mkdtemp(join(process.cwd(), '.worker-native-canonical-test-'))
  cleanups.push(() => rm(canonicalRoot, { recursive: true, force: true }))
  if (f.scope.chat.kind !== 'agent') throw new Error('fixture')
  f.scope.chat.runId = randomUUID(); f.scope.chat.executionId = randomUUID()
  const token = await f.issue()
  const context: TransferContext = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const rootBinding = { rootId: randomUUID(), rootBindingRevision: 1 }
  const intent: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: context.mainId, runId: f.scope.chat.runId,
    nodeId: 'producer', executionId: f.scope.chat.executionId, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: randomUUID(), operationId: randomUUID(), bindingHash: hash('accepted original placement'), inputDigest: `sha256:${hash('input')}`,
    owner: { grantId: 'unit-original-grant', epoch: '1' } }
  const placement: AcceptedNodePlacement = { schemaVersion: 1, mainId: intent.mainId, runId: intent.runId, nodeId: intent.nodeId,
    hostRef: { kind: 'device', mainId: context.mainId, deviceId: context.deviceId },
    registration: { workerInstallationId: context.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-unit-installation', destination: { canonicalProjectRoot: root, canonicalCwd: root, managedRuntimeRoot: root,
      directoryIdentityHash: hash('unit-root'), rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'unit-attestation', attestationHash: hash('unit-attestation') },
    source: { revisionId: 'source', manifestDigest: hash('source'), materializationId: 'materialization', materializationDigest: hash('materialization') },
    payload: { kind: 'agent', agentId: f.scope.chat.agentId, agentConfigurationVersionId: 'saved-configuration', driverId: 'driver',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'installation', installationFingerprint: 'fingerprint',
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [], artifactOutputs: { version: 1, outputKeys: ['report'] } },
    bindingHash: intent.bindingHash }
  const accepted: AcceptedArtifactPublication = { context: f.context, transferContext: context,
    attempt: { workspaceId: f.scope.chat.workspaceId, workflowId: f.scope.chat.workflowId, runId: intent.runId, nodeId: intent.nodeId,
      executionId: intent.executionId, attemptId: intent.attemptId, placementHash: intent.bindingHash } }
  const authority = { authorize: vi.fn(async () => f.sessions.authenticate(token, 'files.publish_result')),
    assertSourceLive: vi.fn(async () => {}) }
  const receiver = new ResumableByteTransferService(join(root, 'receiver'), { authorize: vi.fn(async () => {}) })
  cleanups.push(() => receiver.close())
  const fileBytes = new FileByteStorage(canonicalRoot, MAX_FILE_BYTES)
  const files = new TemporaryFileService(f.repository, fileBytes,
    { resolve: async () => f.scope }, undefined, f.clock)
  const links = new Map<string, DistributedPublicationLink>()
  const publisher = new DistributedArtifactPublicationService(files, { read: async (_owner, id) => links.get(id),
    linkPublication: async link => {
      const prior = links.get(link.requestId)
      if (prior && prior.publicationInputHash !== link.publicationInputHash) throw new Error('Conflicting canonical publication')
      if (!prior) links.set(link.requestId, structuredClone(link))
    } }, receiver, authority, f.clock)
  const admissions = new Map<string, TransferIntent>()
  const main: WorkerNativeArtifactApplication = {
    admit: vi.fn(async input => {
      await authority.authorize()
      const prior = admissions.get(input.commandId)
      if (prior) return structuredClone(prior)
      const transfer: TransferIntent = { version: 1, ...context, ...rootBinding, transferId: randomUUID(), operationId: intent.operationId,
        executionId: intent.executionId, attemptId: intent.attemptId, placementHash: intent.bindingHash, direction: 'to-main', byteClass: 'artifact',
        sha256: input.sha256, byteSize: input.byteSize, manifestDigest: workflowArtifactTransferManifestDigest(input),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), chunkBytes }
      admissions.set(input.commandId, transfer); return structuredClone(transfer)
    }),
    publish: vi.fn(async input => publisher.publishAccepted(accepted, input.transferId, input.publication, 'mcp')),
  }
  const callback = { assertCurrent: vi.fn(async () => {}) }, call = { assertCurrent: vi.fn(async () => {}) }, protectedStorage = vi.fn(async () => {})
  // Existing private root is a test stand-in. No native process is launched or
  // claimed to be fenced by this permissive qualification callback.
  const registry = await WorkerNativeOutputRegistry.open({ configuration: { harness: 'codex', model: 'unit-only', reasoningEffort: 'low',
    sandbox: 'workspace-write', serviceTier: 'standard' }, scope: f.scope, callback, authority: { assertCurrent: async () => { await authority.authorize() } },
    storage: { rootDirectory: root, assertProtected: protectedStorage,
      reserve: async () => ({ assertCurrent: async () => {}, release: async () => {} }) },
    publisher: { publish: (input, originalCall, signal) => sender.publish(input, originalCall, signal) } })
  cleanups.push(() => registry.withdraw())
  const connection = { current: vi.fn(async () => context), retryable: (error: unknown) => error instanceof Error && error.message === 'carrier lost' }
  const sender = new WorkerNativeArtifactSender({ intent, placement, root: rootBinding }, registry, main, receiver, connection)
  const dispatch = (command: Parameters<WorkerNativeOutputRegistry['dispatch']>[0]) => registry.dispatch(command, call)
  const created = await dispatch({ operation: 'create', commandId: randomUUID(), filename: 'result.md', mediaType: 'text/markdown' })
  if (created.operation !== 'create') throw new Error('fixture')
  const artifactId = created.artifactId
  for (let offset = 0; offset < body.length; offset += 64 * 1024) await dispatch({ operation: 'append', commandId: randomUUID(),
    artifactId, offset, contentBase64: body.subarray(offset, offset + 64 * 1024).toString('base64') })
  await dispatch({ operation: 'seal', commandId: randomUUID(), artifactId })
  const descriptor = { commandId: randomUUID(), artifactId, filename: 'result.md', mediaType: 'text/markdown' as const }
  const publication: AgentFilePublishInput = { ...descriptor, scope: f.scope }
  const publish = () => dispatch({ operation: 'publish', publication: descriptor })
  return { f, root, intent, placement, rootBinding, context, body, registry, callback, call, protectedStorage, sender, main, receiver, connection,
    files, fileBytes, canonicalRoot, authority, publisher, token, accepted, publication, publish, admissions, links }
}

async function installedProducer(t: Awaited<ReturnType<typeof fixture>>) {
  if (t.placement.payload.kind !== 'agent') throw new Error('Expected Agent fixture')
  const agentId = t.placement.payload.agentId
  const binding: DeviceSessionBinding = { ...t.context, connectionGeneration: 1 }
  const pairing = { ...t.context, protocolVersion: 1 } as unknown as WorkerPairingConfiguration
  await ensureInstalledWorkflowOutputStore(t.root, pairing)
  const publications = new WorkflowNativeArtifactResults(t.placement, t.intent)
  const q: CodexNativeOutputQualificationInput = {
    configuration: { harness: 'codex', model: 'unit-only', reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard' },
    binary: '/recorded/codex', binaryIdentity: 'recorded-binary', providerVersion: 'codex-cli 0.154.0', schemaIdentity: hash('schema'),
    expectedSandbox: { cwd: t.canonicalRoot, writableRoots: [], networkAccess: false,
      excludeSlashTmp: true, excludeTmpdirEnvVar: true, tmpdir: undefined },
  }
  const pin: CodexNativeOutputTurnPin = { session: { harness: 'codex', providerVersion: q.providerVersion,
    nativeSessionId: t.f.context.nativeSessionId }, connectionId: 'original-native-connection', runtimeGeneration: 1,
    nativeTurnId: t.f.context.turnId!, assertCurrent: vi.fn() }
  const context: InstalledWorkflowNativeOutputContext = {
    intent: t.intent, placement: t.placement, binding,
    materialization: { receipt: { binding: { rootId: t.rootBinding.rootId,
      bindingRevision: t.rootBinding.rootBindingRevision } } } as InstalledWorkflowNativeOutputContext['materialization'],
    assertCurrent: vi.fn(async () => {}),
    // Recorded native qualification/closure boundaries only; no native process is claimed by this fixture.
    qualifyNativeOutput: vi.fn(async () => {}), qualifyOpenCodeNativeOutput: vi.fn(async () => {}), qualifyBufferedCodexNativeOutput: vi.fn(async () => {}), closeNativeOutputWriters: vi.fn(async () => {}),
    applicationAccess: () => ({ kind: 'scoped-worker-mcp', token: t.token, agentId,
      executionId: t.intent.executionId, attemptId: t.intent.attemptId, operationId: t.intent.operationId,
      bindingHash: t.intent.bindingHash }),
    observeArtifactPublication: (input, result) => publications.observe(input, result),
    requestMain: vi.fn(async raw => {
      const request = WorkerMcpRelayRequestSchema.parse(raw)
      await t.f.sessions.authenticate(request.applicationAccess.token, 'files.publish_result')
      const lease = { version: 1, mainId: t.context.mainId, principalId: t.f.principal.id, audience: 'worker',
        agentId, executionId: t.intent.executionId, operationId: t.intent.operationId,
        attemptId: t.intent.attemptId, bindingHash: t.intent.bindingHash, expiresAt: '2099-01-01T00:00:00.000Z' }
      if (request.operation === 'worker-mcp.authorize-native-output-declarations') return { payload: { ...lease,
        agentConfigurationVersionId: t.placement.payload.kind === 'agent' ? t.placement.payload.agentConfigurationVersionId : '',
        outputOperations: ['create', 'append', 'seal', 'publish'] } }
      if (request.operation === 'worker-mcp.authorize-native-output') return { payload: { ...lease,
        outputOperation: request.outputOperation, nativeSessionId: request.nativeSessionId, turnId: request.turnId, scope: t.f.scope } }
      throw new Error('Install fixture must mount its authenticated Main MCP path before publication')
    }),
  }
  const captured = { binding, request: async (raw: unknown, options?: { bytes?: Uint8Array }) => {
    const request = raw as { method: string; transferId: string; offset: number; sha256: string }
    const admitted = [...t.admissions.values()].find(value => value.transferId === request.transferId)!
    if (request.method === 'start') return { payload: await t.receiver.start(admitted, t.context) }
    if (request.method === 'status') return { payload: await t.receiver.status(request.transferId, t.context) }
    if (request.method === 'append') return { payload: await t.receiver.append(request.transferId, t.context,
      { offset: request.offset, sha256: request.sha256, bytes: options!.bytes! }) }
    if (request.method === 'finish') return { payload: await t.receiver.finish(request.transferId, t.context) }
    throw new Error('Unexpected artifact byte operation')
  } }
  const factory = createInstalledWorkflowNativeOutputFactory({ stateDirectory: t.root, pairing,
    connection: () => ({ captureRequest: () => captured }) })
  const ports = factory(context)
  const native = createInstalledNativeOutputs(ports)
  const prepare = () => native.prepare({ ...q, effectiveSandbox: { ...q.expectedSandbox, writableRoots: [q.expectedSandbox.cwd] },
    session: pin.session, clientCorrelationId: `execution:${t.intent.executionId}`, connectionId: pin.connectionId,
    runtimeGeneration: pin.runtimeGeneration }, new AbortController().signal)
  return { context, native, q, pin, prepare, publications, pairing }
}

describe('original worker-native artifact sender', () => {
  it('hands an installed producer on one computer to a second computer through authenticated MCP after a lost publication reply', async ({ onTestFailed }) => {
    let stage = 'fixture'
    onTestFailed(() => { console.error(`Artifact handoff stopped at: ${stage}`) })
    // Use the production chunk window here; the resume cases below separately
    // exercise small chunks and lost chunk acknowledgments.
    const t = await fixture(undefined, BYTE_TRANSFER_POLICY.maxChunkBytes)
    const producer = await installedProducer(t)
    const app = Fastify()
    cleanups.push(() => app.close())
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
      .send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' } }))
    const consumer = { ...t.accepted.attempt, nodeId: 'consumer', executionId: randomUUID(),
      attemptId: randomUUID(), placementHash: hash('second-computer-placement') }
    const receiverGrant = { principalId: 'consumer-on-second-computer', grantId: 'consumer-grant', grantRevision: '1' }
    const bindings = new Map<string, ArtifactEdgeBinding>()
    let receiverAllowed = true
    const query = { query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) }
    const edges = new ArtifactEdgeService({
      read: async id => bindings.get(id),
      pin: async (binding, authorize) => {
        await authorize(query)
        const prior = bindings.get(binding.edgeId)
        if (prior && !isDeepStrictEqual(prior, binding)) throw new Error('Conflicting original edge')
        bindings.set(binding.edgeId, structuredClone(binding))
        return structuredClone(prior ?? binding)
      },
      recordRead: async (_binding, _readAt, authorize) => { await authorize(query) },
    }, t.f.repository, t.fileBytes, { assertCurrent: async binding => {
      await t.authority.authorize()
      if (!receiverAllowed || !isDeepStrictEqual(binding.consumer, consumer)
        || !isDeepStrictEqual(binding.receiver, receiverGrant)) throw new DomainError('FILE_EDGE_DENIED', 'Receiver denied.', 403)
    } }, t.f.clock)
    registerDistributedArtifacts(app, edges, t.publisher, {
      producer: async request => {
        await t.f.sessions.authenticate(String(request.headers.authorization).replace(/^Bearer /, ''), 'files.publish_result')
        return t.accepted
      },
      consumer: async request => {
        if (request.headers.authorization !== 'Bearer second-computer-token')
          throw new DomainError('FILE_EDGE_DENIED', 'Consumer credential denied.', 403)
        return { attempt: consumer, authority: receiverGrant }
      },
    })
    stage = 'listen'
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const requestMcp = async (path: string, body: unknown, token: string) => {
      stage = `request ${path}`
      const response = await fetch(new URL(path, address), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json, text/event-stream' }, body: JSON.stringify(body),
      })
      stage = `response ${path}`
      const bodyText = await response.text()
      stage = `read response ${path}`
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      return { statusCode: response.status, headers: { 'content-type': response.headers.get('content-type') ?? '' },
        body: bodyText }
    }
    const requestMain = vi.mocked(producer.context.requestMain).getMockImplementation()!
    let loseReply = true
    vi.mocked(producer.context.requestMain).mockImplementation(async (raw, signal) => {
      const request = WorkerMcpRelayRequestSchema.parse(raw)
      if (request.operation !== 'worker-mcp.request') return requestMain(raw, signal)
      const body = request.body as { id: string; params: { name: string; arguments: Parameters<typeof t.main.admit>[0] } }
      if (body.params.name === 'files.admit_transferred_result') return { payload: { statusCode: 200,
        contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id,
          result: { structuredContent: await t.main.admit(body.params.arguments) } }) } }
      const reply = await requestMcp('/mcp/artifact-publications', request.body, t.token)
      if (loseReply) { loseReply = false; throw new Error('publication ACK lost') }
      return { payload: { statusCode: reply.statusCode,
        contentType: reply.headers['content-type']?.startsWith('text/event-stream') ? 'text/event-stream' : 'application/json',
        body: reply.body } }
    })
    stage = 'prepare'
    const bridge = await producer.prepare()
    cleanups.push(() => bridge.close())
    const signal = new AbortController().signal
    stage = 'activate'
    await bridge.activate(producer.pin, signal)
    const callback = { ...producer.pin, rpcId: 'rpc', callId: 'original-call' }
    stage = 'create'
    const created = await bridge.dispatch({ operation: 'create', commandId: randomUUID(),
      filename: 'result.md', mediaType: 'text/markdown' }, callback, signal)
    if (created.operation !== 'create') throw new Error('Expected native output allocation')
    stage = 'append'
    await bridge.dispatch({ operation: 'append', commandId: randomUUID(), artifactId: created.artifactId,
      offset: 0, contentBase64: t.body.toString('base64') }, callback, signal)
    stage = 'seal'
    await bridge.dispatch({ operation: 'seal', commandId: randomUUID(), artifactId: created.artifactId }, callback, signal)
    const commandId = randomUUID()
    const publication = { operation: 'publish' as const, publication: { commandId, artifactId: created.artifactId,
      filename: 'result.md', mediaType: 'text/markdown' as const } }
    const result = { outcome: 'succeeded' as const, output: { text: JSON.stringify({ data: { edits: true },
      artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId }] } }) } }
    stage = 'publish'
    await expect(bridge.dispatch(publication, callback, signal)).rejects.toThrow('publication ACK lost')
    expect(() => producer.publications.read(result)).toThrow()
    expect(bindings.size).toBe(0)
    expect(t.links.size).toBe(1)
    const original = [...t.links.values()][0]!
    stage = 'retry publication'
    const published = await bridge.dispatch(publication, callback, signal)
    if (published.operation !== 'publish') throw new Error('Expected publication')
    expect(published.result.replayed).toBe(true)
    expect(published.result.value.revision.revisionId).toBe(original.ref.revisionId)
    expect(t.links.size).toBe(1)
    expect(t.f.repository.allocations.size).toBe(1)
    expect(producer.publications.read(result)).toMatchObject({ output: { kind: 'published-artifacts', result },
      artifactDigests: [hash(t.body)] })
    const outputs = new Map<string, WorkflowNativeArtifactOutput>()
    const native = new NativeArtifactOutputs(new CanonicalNativeArtifactResults(t.files, {
      read: async (_owner, id) => t.links.get(id), linkPublication: async () => { throw new Error('Read only') },
    }, t.authority, t.f.clock), {
      read: async (_attempt, key) => outputs.get(key),
      bind: async (output, authorize) => { await authorize(query); outputs.set(output.outputKey, output); return output },
    }, t.authority, edges)
    stage = 'accept output'
    await native.acceptOutput(t.accepted, 'report', commandId)
    stage = 'pin edge'
    const edge = await native.pinEdge(t.accepted, { edgeId: randomUUID(), commandId: randomUUID(),
      producer: t.accepted.attempt, consumer, outputKey: 'report', receiver: receiverGrant,
      sender: { principalId: t.f.principal.id, grantId: 'producer-grant', grantRevision: '1' },
      access: 'read-only', acceptedAt: t.f.clock().toISOString() })
    const read = (token: string) => requestMcp('/mcp/artifact-inputs',
      { jsonrpc: '2.0', id: 'read', method: 'tools/call', params: { name: 'files.read_edge_input',
        arguments: { edgeId: edge.edgeId, offset: 0, length: t.body.length } } }, token)
    const reply = await read('second-computer-token')
    expect(reply.statusCode).toBe(200)
    const mcpReply = (response: typeof reply) => response.headers['content-type']?.startsWith('text/event-stream')
      ? JSON.parse(/^data: (.+)$/m.exec(response.body)![1]!) : JSON.parse(response.body)
    const returned = mcpReply(reply).result.structuredContent
    expect(Buffer.from(returned.contentBase64, 'base64')).toEqual(t.body)
    expect(returned.revision.revisionId).toBe(original.ref.revisionId)
    expect((await read('foreign-computer-token')).statusCode).toBe(403)
    receiverAllowed = false
    expect(mcpReply(await read('second-computer-token')).result.isError).toBe(true)
    expect(t.links.size).toBe(1)
    stage = 'close bridge'
    await bridge.close()
    expect(producer.context.closeNativeOutputWriters).toHaveBeenCalled()
  })

  it('refuses a missing or replacement output store and absent native qualification', async () => {
    const t = await fixture()
    const producer = await installedProducer(t)
    await expect(ensureInstalledWorkflowOutputStore(t.root, producer.pairing)).resolves.toBeUndefined()
    vi.mocked(producer.context.qualifyNativeOutput).mockRejectedValue(new Error('Native write denial absent'))
    await expect(producer.prepare()).rejects.toThrow('Native write denial absent')
    expect(t.links.size).toBe(0)
    const missingStore = join(t.root, 'missing-output-store')
    await mkdir(missingStore, { mode: 0o700 })
    const other = createInstalledWorkflowNativeOutputFactory({ stateDirectory: missingStore, pairing: producer.pairing,
      connection: () => undefined })(producer.context)
    await expect(other.assertQualified(producer.q, new AbortController().signal)).rejects.toMatchObject({ code: 'ENOENT' })
    t.f.denyWrites()
    await expect(producer.prepare()).rejects.toThrow()
    expect(t.links.size).toBe(0)
    await rm(join(t.root, 'workflow-native-outputs'), { recursive: true })
    await expect(ensureInstalledWorkflowOutputStore(t.root, producer.pairing)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('transfers real tool-created bytes, verifies receipt and publishes exact canonical pins', async () => {
    const t = await fixture(), reply = await t.publish()
    if (reply.operation !== 'publish') throw new Error('fixture')
    const original = reply.result
    expect(original.value.revision).toMatchObject({ sha256: hash(t.body), byteSize: t.body.length, filename: 'result.md', origin: 'agent_output' })
    const transfer = t.admissions.get(t.publication.commandId)!
    const receipt = await t.receiver.resolveVerifiedReceipt(transfer.transferId, t.context)
    expect(receipt.sha256).toBe(hash(t.body)); expect(receipt.intent).toEqual(transfer)
    const downloaded = await t.files.download(t.f.principal, { kind: 'agent', workspaceId: 'workspace-a', conversationId: 'conversation-a' },
      { fileId: original.value.file.fileId, revisionId: original.value.revision.revisionId })
    const chunks: Buffer[] = []
    for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(t.body)
    expect(await t.publish()).toEqual(reply)
    expect(t.main.publish).toHaveBeenCalledTimes(1); expect(t.links.size).toBe(1)
  })
  it('accepts actual maximum append chunks and transfers a multi-chunk frozen artifact', async () => {
    const t = await fixture(Buffer.from(`# ${'a'.repeat(64 * 1024)}\n`), 64 * 1024)
    const append = vi.spyOn(t.receiver, 'append'), reply = await t.publish()
    expect(reply.operation).toBe('publish')
    expect(append.mock.calls.map(call => call[2].bytes.byteLength)).toEqual([64 * 1024, 3])
  })
  it('resumes real receiver bytes after lost chunk/final acknowledgments and keeps original command', async () => {
    const t = await fixture(), append = t.receiver.append.bind(t.receiver), finish = t.receiver.finish.bind(t.receiver)
    vi.spyOn(t.receiver, 'append').mockImplementationOnce(async (...args) => { await append(...args); throw new Error('carrier lost') })
    vi.spyOn(t.receiver, 'finish').mockImplementationOnce(async (...args) => { await finish(...args); throw new Error('carrier lost') })
    t.connection.current.mockResolvedValue({ ...t.context, connectionEpoch: randomUUID() })
    expect((await t.publish()).operation).toBe('publish')
    expect(t.main.admit).toHaveBeenCalledWith({ commandId: t.publication.commandId, sha256: hash(t.body), byteSize: t.body.length }, expect.any(AbortSignal))
    expect(t.links.size).toBe(1)
  })
  it('replays the same canonical allocation after a lost publication reply', async () => {
    const t = await fixture(), publish = vi.mocked(t.main.publish).getMockImplementation()!
    vi.mocked(t.main.publish).mockImplementationOnce(async (...args) => { await publish(...args); throw new Error('publication ACK lost') })
    await expect(t.publish()).rejects.toThrow('publication ACK lost')
    expect(t.links.size).toBe(1)
    const first = [...t.links.values()][0]!
    const reply = await t.publish()
    if (reply.operation !== 'publish') throw new Error('fixture')
    expect(reply.result.value.revision.revisionId).toBe(first.ref.revisionId)
    expect(reply.result.replayed).toBe(true); expect(t.admissions.size).toBe(1)
  })
  it.each(['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'operationId', 'executionId',
    'attemptId', 'placementHash', 'rootId', 'rootBindingRevision', 'direction', 'byteClass', 'sha256', 'byteSize', 'manifestDigest'] as const)('rejects a foreign admitted %s before starting transfer', async field => {
    const t = await fixture(), admit = vi.mocked(t.main.admit).getMockImplementation()!
    vi.mocked(t.main.admit).mockImplementationOnce(async (...args) => {
      const transfer = await admit(...args)
      return { ...transfer, [field]: field === 'direction' ? 'to-worker' : field === 'byteClass' ? 'source'
        : ['keyRevision', 'authorizationRevision', 'rootBindingRevision', 'byteSize'].includes(field) ? 2
          : ['placementHash', 'sha256', 'manifestDigest'].includes(field) ? hash('foreign') : randomUUID() }
    })
    const start = vi.spyOn(t.receiver, 'start')
    await expect(t.publish()).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    expect(start).not.toHaveBeenCalled(); expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('denies current Main write authority without upload or canonical publication', async () => {
    const t = await fixture(), start = vi.spyOn(t.receiver, 'start')
    t.f.denyWrites()
    await expect(t.publish()).rejects.toThrow()
    expect(start).not.toHaveBeenCalled(); expect(t.links.size).toBe(0)
  })
  it('never publishes after an invalid final receipt', async () => {
    const t = await fixture(), finish = t.receiver.finish.bind(t.receiver)
    vi.spyOn(t.receiver, 'finish').mockImplementationOnce(async (...args) => ({ ...await finish(...args), sha256: hash('foreign') }))
    await expect(t.publish()).rejects.toThrow('receipt identity mismatch')
    expect(t.main.publish).not.toHaveBeenCalled(); expect(t.links.size).toBe(0)
  })
  it.each(['hash', 'scope', 'metadata'] as const)('rejects mismatched canonical %s readback without a success reply', async kind => {
    const t = await fixture(), publish = vi.mocked(t.main.publish).getMockImplementation()!
    vi.mocked(t.main.publish).mockImplementationOnce(async (...args) => {
      const result = structuredClone(await publish(...args))
      if (kind === 'hash') result.value.revision = { ...result.value.revision, sha256: hash('foreign') }
      if (kind === 'scope') result.value.file = { ...result.value.file, scope: t.f.foreign }
      if (kind === 'metadata') result.value.revision = { ...result.value.revision, filename: 'foreign.md' }
      return result
    })
    await expect(t.publish()).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    expect(t.links.size).toBe(1) // Canonical fact exists, but no acceptance is fabricated.
  })
  it('rechecks original callback after real receiver completion before Main publication', async () => {
    const t = await fixture(), finish = t.receiver.finish.bind(t.receiver)
    vi.spyOn(t.receiver, 'finish').mockImplementationOnce(async (...args) => {
      const receipt = await finish(...args)
      t.callback.assertCurrent.mockRejectedValue(new Error('original turn withdrawn')); return receipt
    })
    await expect(t.publish()).rejects.toThrow('original turn withdrawn')
    expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('checks this publication callback after Main admission before transfer effects', async () => {
    const t = await fixture(), admit = vi.mocked(t.main.admit).getMockImplementation()!
    vi.mocked(t.main.admit).mockImplementationOnce(async (...args) => {
      const transfer = await admit(...args)
      t.call.assertCurrent.mockRejectedValue(new Error('publication callback withdrawn'))
      return transfer
    })
    const start = vi.spyOn(t.receiver, 'start')
    await expect(t.publish()).rejects.toThrow('publication callback withdrawn')
    expect(start).not.toHaveBeenCalled(); expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('checks this original callback after carrier connection awaits before start', async () => {
    const t = await fixture(), start = vi.spyOn(t.receiver, 'start')
    t.connection.current.mockImplementationOnce(async () => {
      t.call.assertCurrent.mockRejectedValue(new Error('original carrier callback withdrawn'))
      return t.context
    })
    await expect(t.publish()).rejects.toThrow('original carrier callback withdrawn')
    expect(start).not.toHaveBeenCalled(); expect(t.main.publish).not.toHaveBeenCalled()
  })
  it('rejects changed frozen source before admission', async () => {
    const t = await fixture()
    const sender = new WorkerNativeArtifactSender({ intent: t.intent, placement: t.placement, root: t.rootBinding }, {
      sealed: async () => ({ sha256: hash(t.body), byteSize: t.body.length, assertCurrent: async () => {},
        read: async () => Buffer.alloc(t.body.length) }),
    }, t.main, t.receiver, t.connection)
    await expect(sender.publish(t.publication, t.call)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
    expect(t.main.admit).not.toHaveBeenCalled()
  })
  it('rejects foreign run scope and cancellation before opening source', async () => {
    const t = await fixture(), source = { sealed: vi.fn(async () => { throw new Error('must not open') }) }
    const sender = new WorkerNativeArtifactSender({ intent: t.intent, placement: t.placement, root: t.rootBinding }, source, t.main, t.receiver, t.connection)
    await expect(sender.publish({ ...t.publication, scope: t.f.foreign }, t.call)).rejects.toThrow()
    const abort = new AbortController(); abort.abort(new Error('cancelled'))
    await expect(sender.publish(t.publication, t.call, abort.signal)).rejects.toThrow('cancelled')
    expect(source.sealed).not.toHaveBeenCalled()
  })
})
