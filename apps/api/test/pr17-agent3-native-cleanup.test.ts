import { describe, expect, it } from 'vitest'
import type { OperatorConfigurationVersion } from '@graphql/contracts'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { configuration as openCodeConfiguration, FixtureServer } from './opencode-fixtures.js'

describe('F8 OpenCode cleanup quiescence interface', () => {
  it('stops automatic replies synchronously without a native write or fabricated terminal result, and rejects foreign sessions', async () => {
    const configuration: OperatorConfigurationVersion = { id: 'operator-v1', operatorId: 'operator', version: 1,
      harness: openCodeConfiguration(), contentHash: 'sha256:test', createdAt: new Date().toISOString() }
    const server = new FixtureServer()
    const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: configuration.operatorId })
    try {
      const session = await manager.createSession({ kind: 'operator', correlationId: 'cleanup-correlation',
        configuration, workingDirectory: '/workspace/project', environment: { agentId: configuration.operatorId, variables: {} } })
      const calls = server.calls.length
      manager.stopAutomaticResponses(session)
      const state = (manager as unknown as { sessions: Map<string, { autoReplies: { stopped: boolean }; turn?: unknown }> }).sessions.get(session.nativeSessionId)
      expect(state?.autoReplies.stopped).toBe(true)
      expect(state?.turn).toBeUndefined()
      expect(server.calls).toHaveLength(calls)
      expect(() => manager.stopAutomaticResponses({ ...session, nativeSessionId: 'not-owned' })).toThrow()
    } finally { server.closeStreams(); await manager.dispose() }
  })
})
