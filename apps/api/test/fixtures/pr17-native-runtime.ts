import assert from 'node:assert/strict'
import type { NativeHarnessEvent, NativeSessionReference, OpenCodeHarnessConfiguration } from '@graphql/contracts'
import { OpenCodeNativeSessionManager, type OpenCodeServerController } from '../../src/modules/harnesses/opencodeServer.js'
import type { NativeSessionStart } from '../../src/modules/harnesses/port.js'

export type OpenCodeState = ReturnType<OpenCodeNativeSessionManager['requireSession']>
export interface OpenCodeTestSeam {
  sessions: Map<string, OpenCodeState>
  recordSynthetic(state: OpenCodeState, type: string, payload: Record<string, unknown>): NativeHarnessEvent
  knownSecrets: Set<string>
  boundEnvironmentFingerprint: string | undefined
}

export const session: NativeSessionReference = {
  harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'native-existing',
}
// Qualification is outside these lifecycle tests. The accepted native fields
// used by create/attach are pinned here, without invoking a real provider.
export const configuration = {
  harness: 'opencode', model: 'provider/model', variant: '', nativeAgent: 'build', thinking: false, autoApprove: false,
} as OpenCodeHarnessConfiguration
export const start = {
  kind: 'workflow', correlationId: 'durable-correlation',
  request: { executionId: 'execution', workingDirectory: '/workspace', configuration: { harness: configuration } },
} as unknown as NativeSessionStart

export function openCodeFixture() {
  let posts = 0
  const controller: OpenCodeServerController = {
    expectedVersion: '1.18.31', ownerAgentId: 'agent',
    ensure: async () => undefined,
    request: async (path, init) => {
      if (init?.method === 'POST' && path.startsWith('/session?')) {
        posts += 1
        return Response.json({ id: session.nativeSessionId })
      }
      if (init?.method === 'GET' && path.includes(`/session/${session.nativeSessionId}`)) {
        return Response.json({ id: session.nativeSessionId, directory: '/workspace' })
      }
      throw new Error(`Unexpected fixture request: ${init?.method} ${path}`)
    },
    dispose: async () => undefined,
  }
  const manager = new OpenCodeNativeSessionManager({ server: controller, ownerAgentId: 'agent' })
  Object.assign(manager, {
    ready: async () => undefined,
    bindEnvironment: async () => undefined,
    configuration: () => configuration,
    assertConfiguration: async () => undefined,
    applyMcpControls: async () => undefined,
    verifyAttachedSession: (native: { id: string; directory: string }, id: string, directory: string) => {
      assert.equal(native.id, id)
      assert.equal(native.directory, directory)
    },
  })
  return { manager, controller, seam: manager as unknown as OpenCodeTestSeam, posts: () => posts }
}

export async function bounded<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The event iterator slept despite an unread event.')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
