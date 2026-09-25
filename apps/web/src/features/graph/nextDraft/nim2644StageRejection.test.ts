import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../shared/api/client'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { repairFixture } from './nim2644State.cases'
import { nextDraftKey, newNextDraft } from './state'
import { isDefinitiveStageRejection, rejectEditOutbox, readEditOutbox, readEditSnapshot,
  reserveEditOutbox, storeEditSnapshot, withEditIntentLock, type EditIntentOutbox } from './editIntentStorage'

const key = nextDraftKey('workspace', 'workflow')
const failure = (code: string, status = 409) => new ApiError({ code, message: `Fixture ${code}` }, status)
function candidate(commandId = 'rejected-stage'): EditIntentOutbox {
  const context = repairFixture()
  return { request: { action: 'stage_edits', workspaceId: 'workspace', workflowId: 'workflow', draftId: context.draft.id,
    commandId, expectedRevision: context.draft.revision, expectedWorkflowVersionId: context.draft.baseWorkflowVersionId,
    executionSemanticsVersion: 3, operations: [] }, target: context.draft.graph }
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

describe('NIM-2644-FE-001 exact no-effect Stage reservation rejection', () => {
  it.each(['REVISION_CONFLICT', 'WORKFLOW_BASE_CONFLICT', 'GRAPH_INVALID', 'AGENT_ID_CONFLICT',
    'AGENT_REVISION_CONFLICT', 'GRAPH_EDIT_INTENT_EXISTS'])('recognizes pre-insert %s only with its domain status', (code) => {
    expect(isDefinitiveStageRejection(failure(code))).toBe(true)
    for (const status of [0, 200, 400, 401, 403, 408, 429, 500, 503]) expect(isDefinitiveStageRejection(failure(code, status))).toBe(false)
  })
  it('recognizes the exact unavailable draft before Stage insertion, not unavailable intent readback', () => {
    expect(isDefinitiveStageRejection(failure('GRAPH_DRAFT_NOT_FOUND', 404))).toBe(true)
    expect(isDefinitiveStageRejection(failure('GRAPH_EDIT_INTENT_NOT_FOUND', 404))).toBe(false)
    expect(isDefinitiveStageRejection(failure('GRAPH_EDIT_INTENT_INVALID'))).toBe(false)
  })
  it.each([
    failure('FORBIDDEN', 403), failure('UNAUTHORIZED', 401), failure('COMMAND_ID_CONFLICT'),
    failure('INVALID_RESPONSE'), failure('INVALID_RESPONSE', 0), failure('UNKNOWN_CONFLICT'),
    failure('REQUEST_TIMEOUT', 408), failure('RATE_LIMITED', 429), failure('INTERNAL_ERROR', 500),
    new Error('lost Stage reply'), Object.assign(new Error('unbranded'), { status: 409, code: 'REVISION_CONFLICT' }),
  ])('retains the exact identity for ambiguous failure %#', async (error) => {
    const outbox = candidate()
    await withEditIntentLock(key, async () => {
      reserveEditOutbox(key, outbox)
      expect(rejectEditOutbox(key, outbox.request, error)).toBe(false)
      expect(readEditOutbox(key)).toEqual(outbox)
      expect(reserveEditOutbox(key, candidate('replacement'))).toEqual(outbox)
    })
  })
  it('releases only the proven rejected reservation; the durable local form and newer typing survive', async () => {
    const context = repairFixture(), edit = newNextDraft(context, 'instance'), outbox = candidate()
    edit.graph = { ...edit.graph, nodes: edit.graph.nodes.map((node) => ({ ...node, initialPrompt: 'correctable local form' })) }
    storeEditSnapshot(key, edit)
    await withEditIntentLock(key, async () => {
      reserveEditOutbox(key, outbox)
      const before = readEditSnapshot(key)
      expect(rejectEditOutbox(key, outbox.request, failure('REVISION_CONFLICT'))).toBe(true)
      expect(readEditOutbox(key)).toBeUndefined()
      expect(readEditSnapshot(key)).toEqual(before)
      expect(reserveEditOutbox(key, candidate('explicit-new-attempt')).request.commandId).toBe('explicit-new-attempt')
    })
  })
  it('does not clear another command or an altered payload with the same command identity', async () => {
    const outbox = candidate()
    await withEditIntentLock(key, async () => {
      reserveEditOutbox(key, outbox)
      expect(() => rejectEditOutbox(key, candidate('different').request, failure('REVISION_CONFLICT'))).toThrow('not cleared')
      expect(() => rejectEditOutbox(key, { ...outbox.request, expectedRevision: 8 }, failure('REVISION_CONFLICT'))).toThrow('not cleared')
      expect(readEditOutbox(key)).toEqual(outbox)
    })
  })
  it('retains a corrupt record rather than interpreting it as a rejected reservation', () => {
    const name = protectedKey('outbox', `graph-edit-intent:${key}`)
    localStorage.setItem(name, '{corrupt')
    expect(() => rejectEditOutbox(key, candidate().request, failure('REVISION_CONFLICT'))).toThrow('not been deleted')
    expect(localStorage.getItem(name)).toBe('{corrupt')
  })
  it('does not claim release when durable removal is unavailable', async () => {
    const outbox = candidate()
    await withEditIntentLock(key, async () => {
      reserveEditOutbox(key, outbox)
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => undefined)
      expect(() => rejectEditOutbox(key, outbox.request, failure('REVISION_CONFLICT'))).toThrow('Durable edit storage')
      expect(readEditOutbox(key)).toEqual(outbox)
    })
  })
})
