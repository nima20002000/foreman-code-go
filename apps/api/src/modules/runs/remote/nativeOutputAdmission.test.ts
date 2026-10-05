import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { TemporaryFileScope } from '@foreman-code/contracts/files'
import { DomainError } from '../../errors.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { createBufferedNativeOutputs, NativeOutputMemoryBudget } from './bufferedNativeOutput.js'
import { awaitNativeOutputContext } from './nativeOutputAdmission.js'

it('admits an immediate original output once Main publishes its genuine scope without changing its command', async () => {
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation',
    workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent', runId: 'run', executionId: 'execution' } }
  let scopeCommitted = false
  let requests = 0
  let openTransactions = 0
  let first!: () => void
  const pending = new Promise<void>(resolve => { first = resolve })
  const output = createBufferedNativeOutputs({ budget: new NativeOutputMemoryBudget(),
    assertQualified: async () => {}, assertCurrent: async () => {},
    authorize: async (pin, _operation, signal) => awaitNativeOutputContext(async bounded => {
      pin.assertCurrent()
      bounded.throwIfAborted()
      requests++
      openTransactions++
      try {
        if (!scopeCommitted) { first(); throw new DeviceApplicationError('NATIVE_ARTIFACT_CONTEXT_PENDING') }
        return scope
      } finally { openTransactions-- }
    }, signal),
    publish: async () => { throw new Error('No publication in admission fixture') },
  }).opencode
  const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'session' }
  const signal = new AbortController().signal
  const bridge = await output.prepare({ configuration: DEFAULT_HARNESS_DEFAULTS.opencode, providerVersion: '1.18.31',
    directory: '/project', session, clientCorrelationId: 'execution:execution', connectionId: 'connection', runtimeGeneration: 1 }, signal)
  const pin = { session, nativeTurnId: 'original-turn', connectionId: 'connection', runtimeGeneration: 1,
    assertCurrent() {} }
  await bridge.activate(pin, signal)
  const command = { operation: 'create' as const, commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' as const }
  const creating = bridge.dispatch(command, { ...pin, callId: 'original-call' }, signal)
  try {
    await pending
    expect(openTransactions).toBe(0)
    scopeCommitted = true
    const created = await creating
    expect(created.operation).toBe('create')
    expect(requests).toBeGreaterThan(1)
    expect(await bridge.dispatch(command, { ...pin, callId: 'same-command-retry' }, signal)).toEqual(created)
  } finally { await bridge.close() }
})
it('cancels pending context admission and never retries a permission or foreign-scope denial', async () => {
  const controller = new AbortController()
  let first!: () => void
  const entered = new Promise<void>(resolve => { first = resolve })
  let requests = 0
  const waiting = awaitNativeOutputContext(async () => {
    requests++
    first()
    throw new DomainError('NATIVE_ARTIFACT_CONTEXT_PENDING', 'pending', 409)
  }, controller.signal)
  await entered
  controller.abort(new Error('original callback closed'))
  await expect(waiting).rejects.toThrow()
  expect(requests).toBe(1)
  let deniedRequests = 0
  await expect(awaitNativeOutputContext(async () => {
    deniedRequests++
    throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'foreign scope', 403)
  })).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
  expect(deniedRequests).toBe(1)
})
