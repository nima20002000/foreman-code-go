import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeFileMcpServer } from '../src/modules/files/claude/server.js'
import type { ClaudeCallbackIdentity } from '../src/modules/harnesses/claudeSdk/interactions.js'
import { fileToolFixture } from './support/fileTools.js'

async function fixture(allowMutation = true) {
  const f = await fileToolFixture()
  const identity: ClaudeCallbackIdentity = { ownerPrincipalId: f.context.ownerPrincipalId,
    nativeSessionId: f.context.nativeSessionId, nativeMessageId: 'observed-message', clientCorrelationId: 'correlation',
    attemptId: 'attempt', generation: 'generation', toolUseId: 'tool-use' }
  const context = { ...f.context, turnId: undefined, nativeMessageId: identity.nativeMessageId, allowMutation }
  const resolve = vi.fn(async (): Promise<ClaudeCallbackIdentity | undefined> => identity)
  const admission = { current: vi.fn(async () => ({ context, expiresAt: new Date(f.clock().getTime() + 60_000) })) }
  const issue = vi.spyOn(f.sessions, 'issueForAcceptedSession')
  const adapter = createClaudeFileMcpServer({ sdk: { createSdkMcpServer, tool }, service: f.service,
    admission, calls: { resolve }, allowMutation })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'claude-file-fixture', version: '1.0.0' })
  await adapter.server.instance.connect(serverTransport)
  await client.connect(clientTransport)
  return { ...f, identity, context, resolve, admission, issue, adapter, client,
    close: async () => { await adapter.close(); await client.close() } }
}

describe('official Claude SDK admitted file MCP server', () => {
  it('uses the actual SDK transport and shared service; discovery creates no credential', async () => {
    const f = await fixture()
    try {
      expect(f.adapter.server.type).toBe('sdk')
      expect((await f.client.listTools()).tools.map(value => value.name)).toHaveLength(6)
      expect(f.issue).not.toHaveBeenCalled()
      const ref = await f.upload('native-file-bytes')
      const result = await f.client.callTool({ name: 'files.read', arguments: { ...ref, offset: 0, length: 6 } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ status: 'ready', contentBase64: Buffer.from('native').toString('base64') })
      expect(f.issue).toHaveBeenCalledOnce()
      expect(f.tools.reads).toMatchObject([{ runId: 'run-a', executionId: 'execution-a', ...ref }])
      f.revoke()
      expect((await f.client.callTool({ name: 'files.read', arguments: ref })).isError).toBe(true)
    } finally { await f.close() }
  })

  it('rejects missing native ACK evidence and child callbacks before credential issuance', async () => {
    const f = await fixture()
    try {
      f.resolve.mockResolvedValueOnce(undefined)
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope } })).isError).toBe(true)
      f.resolve.mockResolvedValueOnce({ ...f.identity, agentId: 'child' })
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope } })).isError).toBe(true)
      f.resolve.mockResolvedValueOnce({ ...f.identity, nativeMessageId: 'planned-uuid' })
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope } })).isError).toBe(true)
      expect(f.issue).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('advertises only reads for a read-only harness and preserves conversation scope', async () => {
    const f = await fixture(false)
    try {
      expect((await f.client.listTools()).tools.map(value => value.name)).toEqual(['files.list', 'files.read'])
      expect((await f.client.callTool({ name: 'files.create_working_copy', arguments: {} })).isError).toBe(true)
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.foreign } })).isError).toBe(true)
    } finally { await f.close() }
  })

  it('rechecks live caller write authority through the existing service', async () => {
    const f = await fixture(), source = await f.upload()
    try {
      f.denyWrites()
      const result = await f.client.callTool({ name: 'files.create_working_copy',
        arguments: { commandId: randomUUID(), source, destination: f.scope } })
      expect(result.isError).toBe(true)
      expect(f.tools.artifacts.size).toBe(0)
    } finally { await f.close() }
  })

  it('creates and publishes through existing artifact ownership, then revokes its private credential', async () => {
    const f = await fixture(), source = await f.upload('original')
    try {
      const copied = await f.client.callTool({ name: 'files.create_working_copy',
        arguments: { commandId: randomUUID(), source, destination: f.scope } })
      expect(copied.isError).not.toBe(true)
      const value = copied.structuredContent as { value: { artifactId: string } }
      const published = await f.client.callTool({ name: 'files.publish_result', arguments: {
        commandId: randomUUID(), artifactId: value.value.artifactId, scope: f.scope, filename: 'result.md', mediaType: 'text/markdown',
      } })
      expect(published.isError).not.toBe(true)
      expect(f.repository.values.size).toBe(2)
      const token = await f.issue.mock.results[0]!.value
      await f.adapter.close()
      await expect(f.sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
    } finally { await f.close() }
  })
})
