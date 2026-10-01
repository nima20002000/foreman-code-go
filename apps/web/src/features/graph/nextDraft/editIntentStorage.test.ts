import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { journalRequest } from './nim2644Journal.fixture'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { protectedKey, rotateProtectedSession } from '../../../shared/api/protectedChatStorage'
import { fixture } from './core.cases'
import { nextDraftKey, newNextDraft } from './state'
import { acknowledgeEditOutbox, clearEditIntentStorage, readEditOutbox, readEditSnapshot,
  reserveEditOutbox, storeEditSnapshot, withEditIntentLock, type EditIntentOutbox } from './editIntentStorage'

const key = nextDraftKey('workspace', 'workflow')
function candidate(commandId = 'exact-stage'): EditIntentOutbox {
  const context = fixture()
  return { request: journalRequest(newNextDraft(context, 'fixture'), commandId), target: context.draft.graph }
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearEditIntentStorage() })

describe('NIM-2642 protected local form and exact-command recovery', () => {
  it('retains staged graph, Agent payload, revision base and independent geometry after memory loss', () => {
    const context = fixture(), edit = newNextDraft(context, 'instance')
    edit.graph = { ...edit.graph, nodes: edit.graph.nodes.map((node, i) => i ? node : { ...node,
      initialPrompt: 'Exact retained edit', position: { x: 987, y: -12 } }) }
    edit.agentEdits = { [context.agents[0]!.agent.id]: { ...context.agents[0]!.agent, name: 'Retained Agent edit' } }
    storeEditSnapshot(key, edit)
    const read = readEditSnapshot(key)!
    expect(read.graph).toEqual(edit.graph); expect(read.context).toEqual(context); expect(read.agentEdits).toEqual(edit.agentEdits)
    // A new tab/reopen can find the last form but thereafter has its own snapshot.
    sessionStorage.removeItem(protectedKey('ui', 'graph-edit-intent:tab'))
    expect(readEditSnapshot(key)).toEqual(read)
    storeEditSnapshot(key, { ...edit, graph: { ...edit.graph, nodes: edit.graph.nodes.map((node) => ({ ...node, initialPrompt: 'New tab' })) } })
    expect(nativeNode(readEditSnapshot(key)?.graph.nodes[0])?.initialPrompt).toBe('New tab')
  })
  it('reuses the SAME request after refresh, duplicate clicks and competing newer forms', async () => {
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
    const first = candidate(), replacement = candidate('replacement')
    expect(await withEditIntentLock(key, async () => reserveEditOutbox(key, first))).toEqual(first)
    expect(readEditOutbox(key)).toEqual(first)
    replacement.target = { ...replacement.target, nodes: replacement.target.nodes.map((node) => ({ ...node, initialPrompt: 'Newer typing' })) }
    expect(await withEditIntentLock(key, async () => reserveEditOutbox(key, replacement))).toEqual(first)
    expect(() => acknowledgeEditOutbox(key, 'replacement')).toThrow('not cleared')
    expect(readEditOutbox(key)).toEqual(first)
    acknowledgeEditOutbox(key, first.request.commandId)
    expect(readEditOutbox(key)).toBeUndefined()
  })
  it('does not clear or replace corrupted and cross-scope retained commands', () => {
    const name = protectedKey('outbox', `graph-edit-intent:${key}`)
    localStorage.setItem(name, '{invalid')
    expect(() => reserveEditOutbox(key, candidate())).toThrow('not been deleted')
    expect(localStorage.getItem(name)).toBe('{invalid')
    localStorage.setItem(name, JSON.stringify({ ...candidate(), request: { ...candidate().request, workspaceId: 'other' } }))
    expect(() => readEditOutbox(key)).toThrow('different workspace')
  })
  it('fails closed before invoking HTTP work without cross-tab locks or durable storage', async () => {
    vi.stubGlobal('navigator', {})
    const effect = vi.fn(async () => undefined)
    await expect(withEditIntentLock(key, effect)).rejects.toThrow('No Stop or save was sent')
    expect(effect).not.toHaveBeenCalled()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    expect(() => reserveEditOutbox(key, candidate())).toThrow('Durable edit storage is unavailable')
  })
  it('isolates records on identity rotation and purges only this feature on explicit session cleanup', () => {
    reserveEditOutbox(key, candidate())
    storeEditSnapshot(key, newNextDraft(fixture(), 'local'))
    localStorage.setItem('unrelated-preference', 'keep')
    clearEditIntentStorage()
    expect(readEditOutbox(key)).toBeUndefined(); expect(readEditSnapshot(key)).toBeUndefined()
    expect(localStorage.getItem('unrelated-preference')).toBe('keep')
    reserveEditOutbox(key, candidate())
    rotateProtectedSession()
    expect(readEditOutbox(key)).toBeUndefined()
  })
})
