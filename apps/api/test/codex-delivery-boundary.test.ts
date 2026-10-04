import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { HarnessExecutionError, NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import { prepareCodexFileTurn } from '../src/modules/harnesses/codexFiles/index.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { calls, collect, input, until } from './fixtures/codex-test-helpers.js'
import { filePorts, fileScope, sourceRef } from './fixtures/codex-file-runtime-helpers.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'

function boundary(operation: NativeDeliveryError['operation'], delivery: NativeDeliveryError['delivery']) {
  return (error: unknown) => error instanceof NativeDeliveryError
    && error.operation === operation && error.delivery === delivery
}

describe('Codex creation and prompt write boundaries', () => {
  let f: Awaited<ReturnType<typeof deliveryFixture>>
  beforeEach(async () => { f = await deliveryFixture() })
  afterEach(async () => { await f.close() })

  for (const fault of ['auth', 'model', 'initialize'] as const) {
    it(`${fault} failure before thread/start permits one explicit creation retry`, async () => {
      const manager = f.makeManager()
      const source = input(f.directory)
      if (fault === 'auth') await f.flag('logged-out')
      if (fault === 'model') await f.json('models.json', { models: [] })
      if (fault === 'initialize') await f.flag('reject-initialize')
      await assert.rejects(manager.createSession(source), boundary('session_creation', 'not_sent'))
      assert.equal((await f.wire('thread/start')).length, 0)
      await f.unflag('logged-out')
      await f.unflag('models.json')
      await f.unflag('reject-initialize')
      const session = await manager.createSession(source)
      assert.equal(session.harness, 'codex')
      assert.equal((await f.wire('thread/start')).length, 1)
      assert.equal((await f.wire('turn/start')).length, 0)
    })
  }

  it('failure after a successful thread/start keeps creation fenced', async () => {
    const manager = f.makeManager(undefined, {
      id: () => { throw new HarnessExecutionError('CODEX_ACTIVATION_FAILED', 'Cannot assign the local connection.') },
    })
    const source = input(f.directory)
    await assert.rejects(manager.createSession(source), boundary('session_creation', 'unknown'))
    await assert.rejects(manager.createSession(source), /may already exist/)
    assert.equal((await f.wire('thread/start')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  it('an idle process exit leaves the next prompt definitely unsent', async () => {
    const manager = f.makeManager()
    const source = input(f.directory)
    const session = await manager.createSession(source)
    await f.flag('idle-exit')
    await until(async () => (await calls(f.directory)).some((entry) => entry.exited) || undefined)
    await until(async () => manager.originalSessionLifetime(session, source) ? undefined : true)
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'next', clientCorrelationId: 'next' })),
      boundary('turn_submission', 'not_sent'))
    assert.equal((await f.wire('turn/start')).length, 0)
  })

  for (const fault of ['prepare', 'recheck'] as const) {
    it(`attachment ${fault} failure cleans up before any prompt write and supports retry`, async () => {
      const ports = filePorts()
      let failing = true
      const files: CodexChatFiles = {
        async prepare({ session, signal }) {
          if (fault === 'prepare' && failing) throw new Error('Attachment source is unavailable.')
          return prepareCodexFileTurn({
            ownerPrincipalId: 'owner-a', scope: fileScope, nativeSessionId: session.nativeSessionId,
            admissionId: 'input-admission', executionHostId: 'execution-host-a', projectMode: 'read', allowMutation: false,
            allowedTools: ['files.list', 'files.read'], expiresAt: new Date(Date.now() + 60_000), attachments: [sourceRef],
          }, { ...ports.dependencies, files: ports.files, source: {
            ...ports.dependencies.source,
            recheck: async () => {
              if (fault === 'recheck' && failing) throw new Error('The pinned attachment was removed.')
              return ports.dependencies.source.recheck()
            },
          } }, signal)
        },
      }
      const manager = f.makeManager(files)
      const session = await manager.createSession(input(f.directory))
      await assert.rejects(collect(manager.startTurn(session, {
        prompt: 'Use the attachment', clientCorrelationId: 'unsent', onSubmitted: async () => assert.fail('Unexpected write'),
      })), boundary('turn_submission', 'not_sent'))
      assert.equal((await f.wire('turn/start')).length, 0)
      assert.equal(ports.tokens.size, 0)
      if (fault === 'recheck') assert(ports.events.includes('host:close'))
      failing = false
      await collect(manager.startTurn(session, {
        prompt: 'Use the attachment', clientCorrelationId: 'retry', onSubmitted: async () => undefined,
      }))
      assert.equal((await f.wire('turn/start')).length, 1)
    })
  }

  it('a connection failure after the prompt write remains uncertain', async () => {
    const manager = f.makeManager()
    const session = await manager.createSession(input(f.directory))
    await assert.rejects(collect(manager.startTurn(session, { prompt: 'lost-start', clientCorrelationId: 'written' })),
      boundary('turn_submission', 'unknown'))
    assert.equal((await f.wire('turn/start')).length, 1)
  })

  it('the admitted lookup recovers only the original late creation without allocation or replay', async () => {
    const source = input(f.directory)
    let allocations = 0
    const admitted = createAdmittedNativeManager('codex', async () => {
      allocations++
      return { manager: f.makeManager() }
    })
    await assert.rejects(admitted.manager.reconcileSessionCreation!(source))
    assert.equal(allocations, 0)
    await f.flag('late-thread-start')
    await assert.rejects(admitted.manager.createSession(source), boundary('session_creation', 'unknown'))
    const session = await until(async () => {
      try { return await admitted.manager.reconcileSessionCreation!(source) } catch { return undefined }
    })
    await assert.rejects(admitted.manager.reconcileSessionCreation!({ ...source, correlationId: 'another-creation' }))
    await assert.rejects(admitted.manager.reconcileSessionCreation!({ ...source,
      request: { ...source.request, configuration: { ...source.request.configuration, id: 'another-configuration' } },
    }))
    assert.equal(session.harness, 'codex')
    assert.equal(allocations, 1)
    assert.equal((await f.wire('thread/start')).length, 1)
    assert.equal((await f.wire('turn/start')).length, 0)
    await admitted.manager.dispose!()
    await assert.rejects(admitted.manager.reconcileSessionCreation!(source))
  })
})
