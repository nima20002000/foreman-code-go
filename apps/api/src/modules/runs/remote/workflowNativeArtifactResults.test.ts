import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentFilePublishInput, AgentFilePublishResult } from '@graphql/contracts/files'
import type { AcceptedNodePlacement, DispatchIntent } from '@graphql/contracts/node-placement'
import { WorkflowNativeArtifactResults } from './workflowNativeArtifactResults.js'

function fixture() {
  const placement = { payload: { kind: 'agent', agentId: 'producer',
    artifactOutputs: { version: 1, outputKeys: ['z', 'a'] } } } as AcceptedNodePlacement
  const intent = { runId: 'run', executionId: 'execution' } as DispatchIntent
  const tracker = new WorkflowNativeArtifactResults(placement, intent)
  const commandId = randomUUID()
  const publication: AgentFilePublishInput = { commandId, artifactId: randomUUID(), filename: 'result.md',
    mediaType: 'text/markdown', scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation',
      workspaceId: 'workspace', workflowId: 'workflow', agentId: 'producer', runId: 'run', executionId: 'execution' } } }
  const fileId = randomUUID()
  const revisionId = randomUUID()
  const createdAt = '2026-10-04T00:00:00.000Z'
  const published: AgentFilePublishResult = { replayed: false, value: {
    file: { fileId, currentRevisionId: revisionId, createdAt, expiresAt: '2026-10-04T01:00:00.000Z', state: 'ready',
      retentionDurationSeconds: 3600, scope: publication.scope },
    revision: { fileId, revisionId, createdAt, filename: publication.filename, mediaType: publication.mediaType,
      sha256: 'a'.repeat(64), byteSize: 4, origin: 'agent_output' },
  } }
  const input = { transferId: randomUUID(), publication }
  const result = (commands = [{ outputKey: 'z', commandId }, { outputKey: 'a', commandId }],
    options: { choice?: true } = {}) => ({
    outcome: 'succeeded' as const, output: { text: JSON.stringify({ data: { original: true },
      ...(options.choice ? { routing: { outcome: 'done' } } : {}), artifactOutputs: { version: 1, outputs: commands } }) },
  })
  return { tracker, input, published, result, commandId }
}

describe('original workflow publication replies', () => {
  it('requires a successful reply before attributing artifact digests to native terminal text', () => {
    const f = fixture()
    expect(() => f.tracker.read(f.result())).toThrow()
    f.tracker.observe(f.input, f.published)
    const original = structuredClone(f.result())
    expect(f.tracker.read(original)).toEqual({ output: { kind: 'published-artifacts', result: original,
      artifactOutputs: { version: 1, outputs: [{ outputKey: 'z', commandId: f.commandId },
        { outputKey: 'a', commandId: f.commandId }] } }, artifactDigests: ['a'.repeat(64), 'a'.repeat(64)] })
    f.tracker.observe(f.input, { ...f.published, replayed: true })
    expect(f.tracker.read(f.result()).output.result).toEqual(original)
  })
  it('keeps choice text intact and refuses changed keys, unpublished commands and mixed output', () => {
    const f = fixture()
    f.tracker.observe(f.input, f.published)
    const result = f.result(undefined, { choice: true })
    expect(f.tracker.read(result).output.result).toEqual(result)
    expect(() => f.tracker.read(f.result([{ outputKey: 'other', commandId: f.commandId }]))).toThrow()
    expect(() => f.tracker.read(f.result([{ outputKey: 'a', commandId: randomUUID() },
      { outputKey: 'z', commandId: f.commandId }]))).toThrow()
    expect(() => f.tracker.read({ ...result, output: { text: result.output.text, extra: true } })).toThrow()
  })
  it.each(['scope', 'pins', 'transfer', 'metadata'] as const)('refuses a changed %s reply for an existing command', kind => {
    const f = fixture()
    f.tracker.observe(f.input, f.published)
    const input = structuredClone(f.input)
    let result = structuredClone(f.published)
    if (kind === 'scope' && input.publication.scope.chat.kind === 'agent') input.publication.scope.chat.executionId = 'foreign'
    if (kind === 'pins') result = { ...result, value: { ...result.value,
      revision: { ...result.value.revision, revisionId: randomUUID() } } }
    if (kind === 'transfer') input.transferId = randomUUID()
    if (kind === 'metadata') result = { ...result, value: { ...result.value,
      revision: { ...result.value.revision, filename: 'replacement.md' } } }
    expect(() => f.tracker.observe(input, result)).toThrow()
    expect(f.tracker.read(f.result()).artifactDigests).toEqual(['a'.repeat(64), 'a'.repeat(64)])
  })
  it('keeps failed native results outside successful output adoption', () => {
    const f = fixture()
    const failed = { outcome: 'failed' as const, error: { code: 'FAILED', message: 'failed', retryable: false } }
    expect(f.tracker.read(failed)).toEqual({ output: { kind: 'text-only', result: failed }, artifactDigests: [] })
  })
})
