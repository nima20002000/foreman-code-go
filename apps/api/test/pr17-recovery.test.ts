import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type HarnessExecution, type NativeSessionReference } from '@graphql/contracts'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { NativeProcessRegistry, spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { sessionAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import type { NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await new NativeProcessRegistry(directory).closeOwner('execution:test').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'graphql-pr17-recovery-'))
  directories.push(path)
  return path
}
const evidence: NativeResponseDeliveryEvidence = {
  source: 'provider_acknowledgement', harness: 'opencode', providerVersion: '1.18.31',
  nativeSessionId: 'session-test', nativeRequestId: 'request-test', nativeRequestType: 'permission.asked',
  optionId: 'once-test', semantic: 'approve_once',
}
const reference: NativeSessionReference = { harness: evidence.harness, providerVersion: evidence.providerVersion,
  nativeSessionId: evidence.nativeSessionId }
const response = { nativeRequestId: evidence.nativeRequestId, nativeRequestType: evidence.nativeRequestType,
  option: { optionId: evidence.optionId, semantic: evidence.semantic, label: 'Approve once', persistence: 'request' as const,
    affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false } }

describe('PR17 durable native response receipts', () => {
  it('recovers from a replacement manager/journal after caller persistence fails', async () => {
    const root = await directory()
    new NativeResponseJournal(root).record(evidence)
    expect(new NativeResponseJournal(root).read(reference, response)).toEqual(evidence)
  })
  it('does not turn missing or conflicting receipts into permission to resend', async () => {
    const journal = new NativeResponseJournal(await directory())
    expect(journal.read(reference, response)).toBeUndefined()
    journal.record(evidence)
    expect(() => journal.record({ ...evidence, semantic: 'reject', optionId: 'reject-test' })).toThrow(/Conflicting/)
    expect(journal.read(reference, response)).toEqual(evidence)
  })
  it('cannot use a receipt for another native session or selected option', async () => {
    const journal = new NativeResponseJournal(await directory())
    journal.record(evidence)
    expect(journal.read({ ...reference, nativeSessionId: 'other' }, response)).toBeUndefined()
    expect(() => journal.read(reference, { ...response, option: { ...response.option, optionId: 'other' } })).toThrow(/does not match/)
  })
})

it.skipIf(process.platform !== 'linux')('PR17 fresh registry closes the registered launch boundary without replay or PID-only signals', async (context) => {
  const root = await directory()
  const registry = new NativeProcessRegistry(root)
  const child = spawnNativeProcess(process.execPath, ['-e', "console.log('ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    cwd: root, env: {}, recovery: registry.scope('execution:test'),
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const ready = await new Promise<boolean>((resolve) => {
    const started = () => { child.removeListener('close', exited); resolve(true) }
    const exited = () => { child.stdout.removeListener('data', started); resolve(false) }
    child.stdout.once('data', started)
    child.once('close', exited)
  })
  if (!ready) {
    expect(stderr).toMatch(/Native launch refused: delegated cgroup v2/)
    expect(await registry.closeOwner('execution:test')).toBe(true)
    context.skip('This process test requires a writable delegated cgroup v2 with cgroup.kill.')
    return
  }
  expect(await new NativeProcessRegistry(root).closeOwner('execution:test')).toBe(true)
  expect(sessionAlive(child.pid!)).toBe(false)
  expect(await registry.closeOwner('execution:test')).toBe(true)
}, 10_000)

it('PR17 terminal execution recovery does not change the unconfirmed approval decision', async () => {
  const fixture = NATIVE_INTERACTION_FIXTURES.codex
  const option = fixture.responseOptions[0]!
  const interaction = { ...fixture, selectedOptionId: option.optionId, selectedSemantic: option.semantic,
    nativeResponse: { optionId: option.optionId }, status: 'delivery_pending' as const,
    deliveryState: 'uncertain' as const, decidedAt: fixture.createdAt }
  const execution: HarnessExecution = {
    id: interaction.executionId, runId: interaction.runId, workflowNodeId: 'node-test', agentId: interaction.requestingAgentId,
    agentConfigurationVersionId: 'configuration-test', attempt: 1, input: {}, state: 'waiting',
    nativeSessionId: interaction.nativeSessionId, createdAt: interaction.createdAt,
  }
  const updateExecution = vi.fn(async () => undefined)
  const runs = { getExecution: async () => execution, updateExecution,
    appendNativeEvent: async () => undefined, recordActivity: async () => undefined } as unknown as PostgresRunRepository
  const coordinator = new ApprovalExecutionCoordinator(runs,
    { coordination: {} } as unknown as PostgresInteractionRepository,
    {} as PostgresApprovalBudgetRepository, {} as NativeSessionManagerResolver, 60_000)
  const session: NativeSessionReference = { harness: interaction.harness,
    providerVersion: interaction.providerVersion, nativeSessionId: interaction.nativeSessionId }
  const correlationId = `execution:${execution.id}`
  const respond = vi.fn(), startTurn = vi.fn()
  const manager = { reconcile: async () => ({ correlationId, nativeTurnId: 'native-turn', events: [], pendingInteractions: [],
    terminalTurn: { correlationId, providerId: 'native-turn', result: { outcome: 'succeeded', output: { text: 'verified' } } } }),
    respond, startTurn } as unknown as NativeHarnessSessionManager
  vi.spyOn(coordinator, 'attachInteraction').mockResolvedValue({ manager, session, signal: new AbortController().signal })
  const owner = { assertOwned() {}, client: {} } as unknown as RunOwnership
  expect(await coordinator.recoverTerminalInteraction(interaction, owner, new AbortController().signal)).toBe(true)
  expect(updateExecution).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed', result: { outcome: 'succeeded', output: { text: 'verified' } } }), owner)
  expect(interaction.deliveryState).toBe('uncertain')
  expect(respond).not.toHaveBeenCalled()
  expect(startTurn).not.toHaveBeenCalled()
})
