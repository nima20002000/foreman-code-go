import { DEFAULT_HARNESS_DEFAULTS, OperatorConfigurationVersionSchema } from '@graphql/contracts'
import { describe, expect, it } from 'vitest'

import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

describe('native session start boundary', () => {
  it('carries the explicit application-global Operator working directory', async () => {
    const manager = new DeterministicNativeSessionManager('codex')
    const configuration = OperatorConfigurationVersionSchema.parse({
      id: 'operator-config-v1', operatorId: 'application-operator', version: 1,
      harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:fixture',
      createdAt: '2026-09-16T00:00:00.000Z',
    })

    await manager.createSession({
      kind: 'operator', correlationId: 'operator-conversation-1', configuration,
      workingDirectory: '/srv/graphql/harness-workspaces/operator',
      environment: { agentId: 'application-operator', variables: {} },
    })

    expect(manager.lastStart).toMatchObject({
      kind: 'operator', workingDirectory: '/srv/graphql/harness-workspaces/operator',
    })
  })

  it('reattaches the persisted provider identity without creating a replacement', async () => {
    const manager = new DeterministicNativeSessionManager('opencode')
    const configuration = OperatorConfigurationVersionSchema.parse({
      id: 'operator-config-v1', operatorId: 'application-operator', version: 1,
      harness: DEFAULT_HARNESS_DEFAULTS.opencode, contentHash: 'sha256:fixture',
      createdAt: '2026-09-16T00:00:00.000Z',
    })
    const persisted = {
      harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'persisted-opencode-session',
    }

    const attached = await manager.attachSession(persisted, {
      kind: 'operator', correlationId: 'operator-conversation-1', configuration,
      workingDirectory: '/srv/graphql/harness-workspaces/operator',
      environment: { agentId: 'application-operator', variables: {} },
    })

    expect(attached).toEqual(persisted)
    expect(manager.counters).toMatchObject({ sessions: 0, attaches: 1 })
    expect(manager.lastStart).toMatchObject({ workingDirectory: '/srv/graphql/harness-workspaces/operator' })
  })
})
