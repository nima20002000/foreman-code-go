import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, withInteractionResponse, type ApprovalResponseOption,
  type DurableInteraction } from '@foreman-code/contracts'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { AcceptedExecutionBinding } from '../../placement/nativeComposition.js'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { prepareRemoteOwnerControl } from './ownerControl.js'
import { readAdmittedRemoteOwnerControl } from './ownerControlAdmission.js'

const native = { sessionId: 'session', turnId: 'turn', processIdentityDigest: 'a'.repeat(64) }
const intent = { schemaVersion: 1 as const, protocolVersion: 1 as const, mainId: randomUUID(), runId: 'run', nodeId: 'node', executionId: 'execution',
  occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: 'a'.repeat(64),
  inputDigest: `sha256:${'a'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } }
const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
const now = '2026-10-01T00:00:00.000Z'
function fixture() {
  const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent, native, connection: { mainId: intent.mainId, deviceId: randomUUID(),
    workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 5, phase: 'running', entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] }
  const interaction: DurableInteraction = { id: 'interaction', revision: 4, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', executionId: 'execution',
    requestingAgentId: 'agent', harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session', nativeRequestId: 'question', nativeRequestType: 'approval',
    graphThreadId: 'run', request: {}, approval: { handler: 'user' }, responseOptions: [option], status: 'decided', selectedOptionId: option.optionId,
    selectedSemantic: option.semantic, nativeResponse: { decision: 'approved' }, deliveryState: 'not_started', decidedAt: now, createdAt: now, updatedAt: now }
  const state = { receipt: receipt as RemoteOperationReceipt | undefined, interaction: interaction as DurableInteraction | undefined,
    cleanup: new Date(now) as Date | undefined, reviewerCompleted: true, unsettledReview: false, owned: true, queries: [] as string[], control: undefined as unknown }
  const raw = { query: async (text: string) => {
    state.queries.push(text)
    if (text.startsWith('select 1 from harness_executions')) {
      const completed = state.reviewerCompleted && !state.unsettledReview
      const rows = completed ? [{ id: 'execution' }] : []
      return { rows, rowCount: rows.length }
    }
    const rows = text.startsWith('select receipt') ? state.receipt ? [{ receipt: state.receipt }] : []
      : text.startsWith('select record') ? state.interaction ? [{ record: state.interaction }] : []
        : text.startsWith('select requested_at') ? state.cleanup ? [{ requested_at: state.cleanup }] : []
          : text.startsWith('select remote_owner_control') ? [{ remote_owner_control: state.control }] : []
    return { rows, rowCount: rows.length }
  } } as unknown as pg.ClientBase
  const owner = { runId: 'run', assertOwned: () => { if (!state.owned) throw new Error('owner lost') }, readOneShotFence: async () => ({ ownerId: 'owner', fence: 'fence' }) } as unknown as RunOwnership
  const db = new ExclusiveGraphConnection(raw, () => owner.assertOwned())
  const binding = { intent, placement: { bindingHash: intent.bindingHash } } as AcceptedExecutionBinding
  const prepare = (kind: 'stop' | 'respond', selected = option) => db.transaction(sql => prepareRemoteOwnerControl(sql, owner, binding,
    kind === 'stop' ? { kind, native } : { kind, native, nativeRequestId: 'question', option: selected }))
  const recover = () => db.transaction(sql => readAdmittedRemoteOwnerControl(sql, owner, binding, {
    interaction: state.interaction!, mode: 'reconcile', attempt: 1, ownerToken: 'owner', correlationId: 'response',
  }))
  return { state, db, prepare, recover }
}
describe('SQL-only admitted remote control preparation', () => {
  it('binds entered form values to the committed decision during preparation and recovery', async () => {
    const f = fixture()
    const offered: ApprovalResponseOption = { ...option, input: { kind: 'form', schema: {
      type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } },
    } } }
    f.state.interaction!.responseOptions = [offered]
    f.state.interaction!.nativeResponse = { optionId: offered.optionId, semantic: offered.semantic, response: { count: 2 } }
    const selected = withInteractionResponse(offered, { count: 2 })
    await expect(f.prepare('respond', withInteractionResponse(offered, { count: 3 }))).rejects.toThrow('native response decision')
    const command = await f.prepare('respond', selected)
    expect(command.action).toMatchObject({ response: selected })
    f.state.control = JSON.parse(JSON.stringify(command))
    expect(await f.recover()).toEqual(command)
    f.state.interaction!.nativeResponse = { response: { count: 3 } }
    await expect(f.recover()).rejects.toThrow('different original operation')
    await f.db.close()
  })

  it('prepares the exact committed decision without issuing IO or mutation', async () => {
    const f = fixture()
    expect(await f.prepare('respond')).toMatchObject({ commandId: 'respond:interaction:4', native, owner: intent.owner,
      action: { kind: 'respond', interactionId: 'interaction', nativeInteractionId: 'question', response: option } })
    expect(f.state.queries.every(text => /^(begin|select|commit)/.test(text))).toBe(true)
    await f.db.close()
  })
  it('reuses a Stop identity from the durable cleanup request', async () => {
    const f = fixture()
    expect(await f.prepare('stop')).toEqual(await f.prepare('stop'))
    f.state.cleanup = undefined
    await expect(f.prepare('stop')).rejects.toThrow('cleanup intent')
    await f.db.close()
  })
  it('closes a completed retained reviewer under its Run owner without requesting Run Stop', async () => {
    const f = fixture()
    f.state.cleanup = undefined
    f.state.receipt!.turnInput = { correlationId: 'execution:execution', promptDigest: 'a'.repeat(64) }
    f.state.receipt!.retainedReviewer = {
      agentId: 'agent', workflowTurnId: 'turn', result: { outcome: 'succeeded' },
      expiresAt: '2026-10-01T01:00:00.000Z',
    }
    try {
      const command = await f.prepare('stop')
      expect(command).toMatchObject({ commandId: 'close-reviewer:operation', native,
        action: { kind: 'stop' }, owner: intent.owner })
      expect(await f.prepare('stop')).toEqual(command)
      f.state.unsettledReview = true
      await expect(f.prepare('stop')).rejects.toThrow('reviewer')
      f.state.unsettledReview = false
      f.state.reviewerCompleted = false
      await expect(f.prepare('stop')).rejects.toThrow('reviewer')
      f.state.reviewerCompleted = true
      f.state.owned = false
      await expect(f.prepare('stop')).rejects.toThrow('owner lost')
    } finally { await f.db.close() }
  })
  it.each(['native', 'owner', 'terminal', 'absent'] as const)('rejects %s ownership before producing a command', async kind => {
    const f = fixture()
    if (kind === 'native') f.state.receipt!.native = { ...native, sessionId: 'replacement' }
    if (kind === 'owner') f.state.receipt!.intent = { ...intent, owner: { grantId: 'other', epoch: '2' } }
    if (kind === 'terminal') { f.state.receipt!.phase = 'confirmed_terminal'; f.state.receipt!.terminal = { kind: 'cancelled', closureEvidenceDigest: 'a'.repeat(64) } }
    if (kind === 'absent') f.state.receipt = undefined
    await expect(f.prepare('respond')).rejects.toThrow('original native ownership')
    await f.db.close()
  })
  it.each(['session', 'execution', 'canceled', 'option'] as const)('rejects a changed %s interaction', async kind => {
    const f = fixture()
    if (kind === 'session') f.state.interaction!.nativeSessionId = 'replacement'
    if (kind === 'execution') f.state.interaction!.executionId = 'replacement'
    if (kind === 'canceled') f.state.interaction!.status = 'canceled'
    if (kind === 'option') {
      const other = CODEX_APPROVAL_OPTIONS_FIXTURE[1]!
      f.state.interaction!.responseOptions.push(other)
      f.state.interaction!.selectedOptionId = other.optionId
      f.state.interaction!.selectedSemantic = other.semantic
    }
    await expect(f.prepare('respond')).rejects.toThrow('exact native response decision')
    await f.db.close()
  })
})
