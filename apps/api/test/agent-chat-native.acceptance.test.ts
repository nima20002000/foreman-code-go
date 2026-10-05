import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, type AgentConfigurationVersion, type NativeSessionReference } from '@foreman-code/contracts'

import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import type { NativeHarnessSessionManager, WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { readNativeSource } from './helpers/agentChatNativeSource.js'

/**
 * Real installed Codex/OpenCode proof for the FEAT-15 native primitives that a live Run cannot
 * reach without a configured Foreman Code MCP: forking a finished session keeps its context in a new
 * session and leaves the source session's history unchanged. Opt in with RUN_REAL_HARNESS_TESTS=1.
 */
const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1'
const binaries = harnessBinaries(process.env)

function configuration(harness: 'codex' | 'opencode'): AgentConfigurationVersion {
  return AgentConfigurationVersionSchema.parse({
    id: `cfg-${randomUUID()}`, workspaceId: 'ws-native-chat', agentId: 'agent-native-chat', version: 1, productRole: 'coder',
    harness: harness === 'codex'
      ? { harness: 'codex', model: process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' }
      : { harness: 'opencode', model: process.env.OPENCODE_TEST_MODEL ?? 'opencode-go/gpt-5.6-luna', variant: 'low', nativeAgent: 'build', thinking: false, autoApprove: false },
    prompt: { system: 'Answer in at most five words.' }, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt: new Date().toISOString(),
  })
}
function start(config: AgentConfigurationVersion, directory: string, conversation: string, delivered: boolean): WorkflowNativeSessionStart {
  return { kind: 'workflow', correlationId: `agent-chat:${conversation}:${randomUUID()}`, instructionsDelivered: delivered, request: {
    executionId: `agent-chat:${conversation}`, runId: `agent-chat:${conversation}`, workspaceId: config.workspaceId, workflowNodeId: 'node-native-chat',
    workingDirectory: directory, runtimeDirectory: directory, configuration: config, input: {} } }
}
async function turn(manager: NativeHarnessSessionManager, session: NativeSessionReference, conversation: string, prompt: string) {
  const correlation = `agent-chat:${conversation}:${randomUUID()}`
  for await (const event of manager.startTurn(session, { prompt, clientCorrelationId: correlation })) void event
  const history = await manager.reconcile(session, correlation)
  expect(history.terminalResult?.outcome).toBe('succeeded')
  return JSON.stringify(history.terminalResult?.output ?? '')
}

describe.skipIf(!enabled)('real native Agent chat fork', () => {
  for (const harness of ['codex', 'opencode'] as const) {
    it(`${harness}: fork keeps context in a new session and leaves the source unchanged`, async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), `agent-chat-${harness}-`)))
      const config = configuration(harness)
      const make = (): NativeHarnessSessionManager => harness === 'codex'
        ? new CodexAppServerSessionManager(binaries.codexBinary)
        : new OpenCodeNativeSessionManager({ server: new ManagedOpenCodeServer({ binary: binaries.openCodeBinary, workingDirectory: directory,
          ownerAgentId: config.agentId }), ownerAgentId: config.agentId, expectedAppMcpEndpoint: 'http://127.0.0.1:9/mcp' })
      const source = make()
      const forker = make()
      try {
        const sourceSession = await source.createSession(start(config, directory, 'source', false))
        expect(await turn(source, sourceSession, 'source', 'Remember the codeword KIWI. Reply OK.')).toMatch(/ok/i)
        const before = (await source.history(sourceSession)).events.length
        const sourceBefore = await readNativeSource(sourceSession, directory, config.agentId)
        const fork = await forker.forkSession!(sourceSession, start(config, directory, 'fork', true))
        expect(fork.nativeSessionId).not.toBe(sourceSession.nativeSessionId)
        expect(await turn(forker, fork, 'fork', 'What codeword did I ask you to remember? One word.')).toMatch(/kiwi/i)
        // The source session is not written by the fork or the fork's turn.
        expect((await source.history(sourceSession)).events.length).toBe(before)
        // Fresh storage observers on BOTH sides: same event counts cannot hide changed content/IDs.
        expect(await readNativeSource(sourceSession, directory, config.agentId)).toBe(sourceBefore)
      } finally {
        await Promise.allSettled([source.dispose?.(), forker.dispose?.()])
        await rm(directory, { recursive: true, force: true })
      }
    }, 240_000)
  }
})
