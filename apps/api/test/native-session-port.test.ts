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
})
