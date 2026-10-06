import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { WorkerOpenCodeFilePreparationSchema, type WorkerOpenCodeFileAction } from '@foreman-code/contracts/remote-execution-rpc'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import { fileToolFixture } from '../../../test/support/fileTools.js'
import { MainWorkerOpenCodeFiles } from './mainWorkerOpenCodeFiles.js'

async function fixture() {
  const files = await fileToolFixture()
  const ref = await files.upload()
  const context = { ...files.context, messageId: 'message-a' }
  const identity = { ownerAgentId: 'agent-a', nativeSessionId: context.nativeSessionId,
    nativeTurnId: context.turnId!, clientCorrelationId: 'agent-chat:conversation-a:command',
    directory: '/accepted-project', configuration: DEFAULT_HARNESS_DEFAULTS.opencode }
  const adopt = vi.fn(async () => {})
  const proxy = new MainWorkerOpenCodeFiles({ service: () => files.service,
    resolve: async () => ({ context, attachments: [ref] }), adopt })
  let acknowledgedTurnId: string | undefined
  let readOnly = false
  const call = (action: WorkerOpenCodeFileAction) => proxy.handle(identity, action, {
    readOnly, acknowledgedTurnId, signal: AbortSignal.timeout(5000),
  })
  return { files, ref, context, identity, proxy, adopt, call,
    acknowledge() { acknowledgedTurnId = identity.nativeTurnId },
    plan() { readOnly = true } }
}

// The file service is real; its memory persistence and recorded acknowledgement do not qualify a native worker.
it('reads pinned inputs before acknowledgement and issues tools only after the accepted native turn', async () => {
  const f = await fixture()
  try {
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(await f.call({ phase: 'prepare' }))
    expect(await f.call({ phase: 'read-input', input: { ...f.ref, offset: 0, length: 65536 } }))
      .toMatchObject({ status: 'ready' })
    await expect(f.call({ phase: 'read-input', input: { ...f.ref, revisionId: 'foreign', offset: 0, length: 1 } }))
      .rejects.toMatchObject({ status: 403 })
    const issue = { phase: 'issue' as const, context: prepared.context, expiresAt: prepared.expiresAt }
    await expect(f.call(issue)).rejects.toMatchObject({ status: 403 })
    f.acknowledge()
    const issued = await f.call(issue) as { token: string }
    expect(await f.call(issue)).toEqual(issued)
    expect(await f.call({ phase: 'authenticate', token: issued.token, tool: 'files.read' }))
      .toMatchObject({ context: prepared.context })
    await f.proxy.close()
    await expect(f.call({ phase: 'authenticate', token: issued.token })).rejects.toMatchObject({ status: 403 })
  } finally { await f.proxy.close() }
})

it('keeps Plan tools read-only even when the saved configuration permits writes', async () => {
  const f = await fixture()
  f.plan()
  try {
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(await f.call({ phase: 'prepare' }))
    expect(prepared.context.allowMutation).toBe(false)
    expect(prepared.context.allowedTools).toEqual(['files.list', 'files.read'])
    f.acknowledge()
    const issued = await f.call({ phase: 'issue', context: prepared.context, expiresAt: prepared.expiresAt }) as { token: string }
    await expect(f.call({ phase: 'service', token: issued.token, operation: 'createWorkingCopy',
      input: { commandId: randomUUID(), source: f.ref, destination: f.files.scope } }))
      .rejects.toMatchObject({ code: 'FILE_TOOL_DENIED' })
  } finally { await f.proxy.close() }
})

it('commits bounded worker snapshot chunks through the normal artifact and publication services', async () => {
  const f = await fixture()
  try {
    const prepared = WorkerOpenCodeFilePreparationSchema.parse(await f.call({ phase: 'prepare' }))
    f.acknowledge()
    const { token } = await f.call({ phase: 'issue', context: prepared.context, expiresAt: prepared.expiresAt }) as { token: string }
    const copied = AgentFileCreateWorkingCopyResultSchema.parse(await f.call({ phase: 'service', token,
      operation: 'createWorkingCopy', input: { commandId: randomUUID(), source: f.ref, destination: f.files.scope } }))
    const artifactId = copied.value.artifactId
    const { writeId } = await f.call({ phase: 'artifact-begin', token, artifactId }) as { writeId: string }
    const transfer = { token, artifactId, writeId, transferId: randomUUID() }
    const bytes = Buffer.from('# worker result\n')
    await f.call({ phase: 'write-begin', ...transfer })
    const chunk = { phase: 'write-chunk' as const, ...transfer, offset: 0, contentBase64: bytes.toString('base64') }
    await f.call(chunk)
    await f.call(chunk)
    await f.call({ phase: 'write-finish', ...transfer })
    await f.call({ phase: 'write-finish', ...transfer })
    const publication = { commandId: randomUUID(), artifactId, scope: f.files.scope,
      filename: 'worker.md', mediaType: 'text/markdown' }
    const published = AgentFilePublishResultSchema.parse(await f.call({ phase: 'service', token,
      operation: 'publish', input: publication }))
    expect(await f.call({ phase: 'service', token, operation: 'publish', input: publication }))
      .toMatchObject({ replayed: true })
    const read = await f.files.service.read(token, { fileId: published.value.file.fileId,
      revisionId: published.value.revision.revisionId, offset: 0, length: 65536 })
    expect(read.status === 'ready' && Buffer.from(read.contentBase64, 'base64').toString('utf8')).toBe(bytes.toString('utf8'))
    await f.call({ phase: 'adopt', context: prepared.context })
    expect(f.adopt).toHaveBeenCalledWith(prepared.context)
    f.files.revoke()
    await expect(f.call({ phase: 'service', token, operation: 'read', input: { ...f.ref, offset: 0, length: 1 } }))
      .rejects.toMatchObject({ status: 401 })
  } finally { await f.proxy.close() }
})
