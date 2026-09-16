import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { HarnessExecutionRequest } from '@graphql/contracts'
import { describe, expect, it } from 'vitest'

import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'

const enabled = process.env.RUN_CODEX_APP_SERVER_TESTS === '1'

describe.skipIf(!enabled)('authenticated Codex app-server 0.154.0', () => {
  it('approves an exact request, continues, inspects, interrupts, and preserves the exec fallback', async () => {
    const directory = process.cwd()
    const marker = join('/tmp', `graphql-nim2598-${process.pid}.txt`)
    const manager = new CodexAppServerSessionManager(process.env.CODEX_BINARY ?? '/home/nima/.local/bin/codex')
    const configuration: HarnessExecutionRequest['configuration']['harness'] = {
      harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
    }
    const request: HarnessExecutionRequest = {
      executionId: 'nim2598-live-execution', runId: 'nim2598-live-run', workspaceId: 'nim2598-live-workspace',
      workflowNodeId: 'nim2598-live-node', workingDirectory: directory, runtimeDirectory: directory, input: {},
      configuration: {
        id: 'nim2598-live-configuration', workspaceId: 'nim2598-live-workspace', agentId: 'nim2598-live-agent', version: 1,
        prompt: {}, assignedSkills: [], harness: configuration,
        contentHash: 'sha256:nim2598-live', createdAt: new Date().toISOString(),
      },
    }
    const input = { request }
    const session = await manager.createSession(input)
    let restored: CodexAppServerSessionManager | undefined
    try {
      const approvalEvents = (async () => {
        for await (const event of manager.startTurn(session, {
          prompt: `Use the shell to run exactly: printf NIM2598_NATIVE_APPROVAL > ${marker}. Then reply exactly NIM2598_APPROVED.`,
          clientCorrelationId: 'nim2598-live-approval',
        })) void event
      })()
      let pending
      for (let attempt = 0; attempt < 120; attempt += 1) {
        pending = await manager.pending(session)
        if (pending) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(pending?.nativeRequestType).toBe('item/commandExecution/requestApproval')
      const approve = pending?.responseOptions.find((option) => option.semantic === 'approve_once')
      expect(approve).toBeDefined()
      await manager.respond(session, pending!.turn.nativeRequestId!, approve!)
      await approvalEvents
      expect((await manager.history(session)).terminalResult).toMatchObject({
        outcome: 'succeeded', output: { text: expect.stringContaining('NIM2598_APPROVED') },
      })

      for await (const event of manager.startTurn(session, {
        prompt: 'Reply exactly NIM2598_CONTINUED. Do not use tools.', clientCorrelationId: 'nim2598-live-continue',
      })) void event
      expect((await manager.history(session)).terminalResult).toMatchObject({
        outcome: 'succeeded', output: { text: expect.stringContaining('NIM2598_CONTINUED') },
      })
      expect(await manager.inspectConfiguration(session, false)).toHaveProperty('config')
      expect(await manager.inspectNativeMcp(session)).toHaveProperty('data')

      const interrupted = (async () => {
        for await (const event of manager.startTurn(session, {
          prompt: 'Think silently for a long time before answering.', clientCorrelationId: 'nim2598-live-interrupt',
        })) void event
      })()
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(await manager.cancel(session)).toBe(true)
      await interrupted
      expect((await manager.history(session)).terminalResult?.outcome).toBe('canceled')

      await manager.close(session)
      restored = new CodexAppServerSessionManager(process.env.CODEX_BINARY ?? '/home/nima/.local/bin/codex')
      expect(await restored.attachSession(session, input)).toEqual(session)
      for await (const event of restored.startTurn(session, {
        prompt: 'Reply exactly NIM2598_REATTACHED. Do not use tools.', clientCorrelationId: 'nim2598-live-reattach',
      })) void event
      expect((await restored.history(session)).terminalResult).toMatchObject({
        outcome: 'succeeded', output: { text: expect.stringContaining('NIM2598_REATTACHED') },
      })

      const fallback = await import('../src/modules/harnesses/codex.js')
      expect(fallback.CodexAdapter).toBeTypeOf('function')
    } finally {
      await manager.close(session)
      await restored?.close(session)
      await rm(marker, { force: true })
    }
  }, 180_000)
})
