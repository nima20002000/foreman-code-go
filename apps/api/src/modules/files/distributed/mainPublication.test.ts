import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { FileByteStorage } from '../storage.js'
import { TemporaryFileService } from '../service.js'
import { bindingIdentity } from '../tools/context.js'
import { MainArtifactPublications, type MainPublicationLedger } from './mainPublication.js'
import type { AcceptedMainArtifactPublication, ArtifactPublicationAuthority } from './publication.js'
import { CanonicalNativeArtifactResults } from './nativeResults.js'
import { NativeArtifactOutputs, type NativeArtifactOutputRepository,
  type WorkflowNativeArtifactOutput } from '../../runs/remote/nativeArtifactOutputs.js'
import { BufferedNativeOutputRegistry, NativeOutputMemoryBudget } from '../../runs/remote/bufferedNativeOutput.js'
import { DomainError } from '../../errors.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const f = await fileToolFixture()
  if (f.scope.chat.kind !== 'agent') throw new Error('Agent scope required')
  f.scope.chat.runId = randomUUID()
  f.scope.chat.executionId = randomUUID()
  const accepted: AcceptedMainArtifactPublication = { location: { kind: 'main', mainId: randomUUID() },
    context: f.context, attempt: { workspaceId: f.scope.chat.workspaceId, workflowId: f.scope.chat.workflowId,
      runId: f.scope.chat.runId, executionId: f.scope.chat.executionId, nodeId: 'producer',
      attemptId: randomUUID(), placementHash: 'a'.repeat(64) } }
  const root = await mkdtemp(join(process.cwd(), '.main-artifacts-test-'))
  roots.push(root)
  const files = new TemporaryFileService(f.repository, new FileByteStorage(root, MAX_FILE_BYTES),
    { resolve: async () => f.scope }, undefined, f.clock)
  const records = new Map<string, NonNullable<Awaited<ReturnType<MainPublicationLedger['read']>>>>()
  const ledger: MainPublicationLedger = { read: async (owner, requestId) => records.get(`${owner}:${requestId}`),
    linkPublication: async link => {
      const key = `${link.ownerPrincipalId}:${link.requestId}`
      if (!records.has(key)) records.set(key, structuredClone(link))
    } }
  let writable = true
  const authority: ArtifactPublicationAuthority = { authorize: async publication => {
    if (!('location' in publication) || publication.location.mainId !== accepted.location.mainId
      || publication.attempt.attemptId !== accepted.attempt.attemptId) throw new DomainError('DENIED', 'Wrong attempt.', 403)
    return { context: { ...f.context, allowMutation: writable }, principal: f.principal, binding: bindingIdentity(f.context) }
  }, assertSourceLive: async () => { throw new Error('Main does not use device transfers') } }
  const publisher = new MainArtifactPublications(files, ledger, authority, f.clock)
  const mappings = new Map<string, WorkflowNativeArtifactOutput>()
  const outputs: NativeArtifactOutputRepository = { read: async (_producer, key) => mappings.get(key),
    bind: async (record, authorize) => {
      await authorize({ query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) })
      if (!mappings.has(record.outputKey)) mappings.set(record.outputKey, structuredClone(record))
      return structuredClone(mappings.get(record.outputKey)!)
    } }
  const results = () => new CanonicalNativeArtifactResults(files, {
    read: async () => undefined, linkPublication: async () => { throw new Error('No device publication') },
  }, authority, f.clock, new MainArtifactPublications(files, ledger, authority, f.clock))
  let active = true
  const current = () => { if (!active) throw new Error('native owner closed') }
  const native = new BufferedNativeOutputRegistry({ scope: f.scope, budget: new NativeOutputMemoryBudget(),
    assertCurrent: current, authorize: async () => {
      current()
      if (!writable) throw new DomainError('DENIED', 'Write grant revoked.', 403)
    }, publish: async (input, source, callback) => publisher.publish(accepted, input, await source.sealed(input, callback)) })
  const dispatch = (input: Parameters<typeof native.dispatch>[0]) => native.dispatch(input, { assertCurrent: current })
  return { f, accepted, root, files, records, results, mappings, outputs, native, dispatch,
    close: async () => { active = false; await native.close() }, revoke: () => { writable = false } }
}
it('publishes sealed Main bytes and recovers canonical original output after producer/service restart', async () => {
  const f = await fixture()
  const created = await f.dispatch({ operation: 'create', commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' })
  if (created.operation !== 'create') throw new Error('create reply')
  const bytes = Buffer.from('# Main output\nOriginal 雪\n')
  await f.dispatch({ operation: 'append', commandId: randomUUID(), artifactId: created.artifactId,
    offset: 0, contentBase64: bytes.toString('base64') })
  await f.dispatch({ operation: 'seal', commandId: randomUUID(), artifactId: created.artifactId })
  const commandId = randomUUID()
  const published = await f.dispatch({ operation: 'publish', publication: { commandId,
    artifactId: created.artifactId, filename: 'report.md', mediaType: 'text/markdown' } })
  expect(published.operation).toBe('publish')
  const outputs = new NativeArtifactOutputs(f.results(), f.outputs, {
    authorize: async () => ({ context: f.accepted.context, principal: f.f.principal,
      binding: bindingIdentity(f.accepted.context) }), assertSourceLive: async () => {},
  }, { pinAccepted: async value => value })
  const original = await outputs.acceptOutput(f.accepted, 'report', commandId)
  expect(original).toMatchObject({ mainPublication: { kind: 'main', mainId: f.accepted.location.mainId,
    attempt: f.accepted.attempt }, pins: { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length } })
  await f.close()
  const restored = new NativeArtifactOutputs(f.results(), f.outputs, {
    authorize: async () => ({ context: f.accepted.context, principal: f.f.principal,
      binding: bindingIdentity(f.accepted.context) }), assertSourceLive: async () => {},
  }, { pinAccepted: async value => value })
  expect(await restored.readOutput(f.accepted, 'report')).toEqual(original)
  const stored = await f.f.repository.read(original.pins.fileId, original.pins.revisionId)
  expect(await readFile(join(f.root, 'objects', stored!.storageKey))).toEqual(bytes)
  expect(f.f.repository.allocations.size).toBe(1)
  expect(f.records.size).toBe(1)
  await expect(f.results().readWorkflowAccepted({ ...f.accepted,
    attempt: { ...f.accepted.attempt, attemptId: randomUUID() } }, commandId)).rejects.toMatchObject({ code: 'DENIED' })
})
it('denies revoked original mutations without allocating canonical files', async () => {
  const f = await fixture()
  f.revoke()
  await expect(f.dispatch({ operation: 'create', commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' }))
    .rejects.toMatchObject({ code: 'DENIED' })
  expect(f.f.repository.allocations.size).toBe(0)
  await f.close()
})
