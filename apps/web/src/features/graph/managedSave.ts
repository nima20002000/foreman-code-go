import type { GraphDraft, GraphDraftOperation } from '@graphql/contracts/management'
import type { applyManagedGraphDraft, revertManagedGraphApply, saveManagedGraphDraft } from '../../shared/api/client'
import type { GraphSaveSnapshot } from './store'
import { captureManagedBase, type ManagedEditBase } from './managedGraphState'

export const GRAPH_APPLY_BATCH_SIZE = 100
export interface PendingManagedLayout {
  nodeId: string
  position: { x: number; y: number }
  commandId: string
  expectedLayoutRevision?: number
}
const LAYOUT_QUEUE_PREFIX = 'graphql:managed-layout:'
export function managedLayoutQueueKey(workflowKey: string, draftId: string): string {
  return `${LAYOUT_QUEUE_PREFIX}${workflowKey}:${draftId}`
}
export function readManagedLayoutQueue(key: string): PendingManagedLayout[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed) || parsed.length > 100) return []
    return parsed.filter((item): item is PendingManagedLayout => item && typeof item === 'object'
      && typeof item.nodeId === 'string' && typeof item.commandId === 'string'
      && typeof item.position?.x === 'number' && Number.isFinite(item.position.x)
      && typeof item.position?.y === 'number' && Number.isFinite(item.position.y)
      && (item.expectedLayoutRevision === undefined || Number.isSafeInteger(item.expectedLayoutRevision)))
  } catch { return [] }
}
export function writeManagedLayoutQueue(key: string, pending: readonly PendingManagedLayout[]): void {
  if (pending.length) sessionStorage.setItem(key, JSON.stringify(pending))
  else sessionStorage.removeItem(key)
}
export function clearManagedLayoutQueues(): void {
  for (let index = sessionStorage.length - 1; index >= 0; --index) {
    const key = sessionStorage.key(index)
    if (key?.startsWith(LAYOUT_QUEUE_PREFIX)) sessionStorage.removeItem(key)
  }
}
export type ManagedPublication = Awaited<ReturnType<typeof saveManagedGraphDraft>>
export interface ManagedSavePlan {
  submitted: GraphSaveSnapshot
  base: ManagedEditBase
  operations: GraphDraftOperation[]
}
interface Attempt extends ManagedSavePlan {
  nextOperation: number
  draft: GraphDraft
  applyRequest?: Parameters<typeof applyManagedGraphDraft>[0]
  saveRequest?: Parameters<typeof saveManagedGraphDraft>[0]
  publication?: ManagedPublication
  appliedCommandIds: string[]
}
interface RevertableApply {
  draft: GraphDraft
  applyCommandIds: string[]
  commandId?: string
}
interface Ports {
  apply: typeof applyManagedGraphDraft
  save: typeof saveManagedGraphDraft
  onApplied: (base: ManagedEditBase) => void
  onSaved: (plan: ManagedSavePlan, saved: ManagedPublication, base: ManagedEditBase) => void
  setSaving: (saving: boolean) => void
  assertSession: () => void
}
function definitiveRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  if (error.code === 'INVALID_REQUEST') return true
  return 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 429 && error.code !== 'HTTP_ERROR' && error.code !== 'INVALID_RESPONSE'
}

/** Workflow-keyed, document-lifetime checkpoints survive navigation and failed responses. */
export class ManagedSaveQueue {
  private readonly attempts = new Map<string, Attempt>()
  private readonly revertable = new Map<string, RevertableApply>()
  private readonly flights = new Map<string, Promise<ManagedPublication>>()
  private epoch = 0
  isRunning(key: string): boolean { return this.flights.has(key) }
  hasPending(key: string): boolean { return this.attempts.has(key) }
  discard(key: string): void {
    if (this.isRunning(key)) throw new Error('A save is still in progress. Local edits cannot be discarded yet.')
    if (this.attempts.has(key)) throw new Error('Retry Save graph to resolve the previous request, then discard any remaining local edits.')
  }
  hasAppliedEdits(key: string): boolean { return Boolean(this.revertable.get(key)?.applyCommandIds.length) }
  async revertApplied(key: string, revert: typeof revertManagedGraphApply,
    onReverted: (base: GraphDraft) => void, assertSession: () => void): Promise<void> {
    this.discard(key)
    const pending = this.revertable.get(key)
    if (!pending) return
    while (pending.applyCommandIds.length) {
      assertSession()
      pending.commandId ??= crypto.randomUUID()
      const result = await revert({
        workspaceId: pending.draft.workspaceId, workflowId: pending.draft.workflowId, draftId: pending.draft.id,
        commandId: pending.commandId, expectedRevision: pending.draft.revision,
        applyCommandId: pending.applyCommandIds.at(-1)!,
      })
      assertSession()
      pending.draft = result.value.draft
      pending.applyCommandIds.pop()
      pending.commandId = undefined
      onReverted(pending.draft)
    }
    this.revertable.delete(key)
  }
  reset(): void { ++this.epoch; this.attempts.clear(); this.revertable.clear(); this.flights.clear() }

  run(key: string, prepare: () => ManagedSavePlan, ports: Ports): Promise<ManagedPublication> {
    const existing = this.flights.get(key)
    if (existing) return existing
    const epoch = this.epoch
    const check = () => { ports.assertSession(); if (epoch !== this.epoch) throw new Error('The editing session changed.') }
    // Defer preparation until after the flight is registered (even synchronous
    // callbacks cannot start a second logical save).
    const task = Promise.resolve().then(async () => {
      check()
      let attempt = this.attempts.get(key)
      if (!attempt) {
        const plan = structuredClone(prepare())
        attempt = { ...plan, draft: plan.base.draft, nextOperation: 0, appliedCommandIds: [] }
        this.attempts.set(key, attempt)
      }
      while (attempt.nextOperation < attempt.operations.length) {
        check()
        attempt.applyRequest ??= {
          workspaceId: attempt.draft.workspaceId, workflowId: attempt.draft.workflowId, draftId: attempt.draft.id,
          commandId: crypto.randomUUID(), expectedRevision: attempt.draft.revision,
          operations: attempt.operations.slice(attempt.nextOperation, attempt.nextOperation + GRAPH_APPLY_BATCH_SIZE),
        }
        const result = await ports.apply(attempt.applyRequest)
        check()
        // Acknowledge our Apply before publication or any optional refresh.
        attempt.nextOperation += attempt.applyRequest.operations.length
        attempt.appliedCommandIds.push(attempt.applyRequest.commandId)
        attempt.draft = result.value.draft
        attempt.base = captureManagedBase(attempt.draft, attempt.base.agents, attempt.base.metadataRevisions)
        attempt.applyRequest = undefined
        ports.onApplied(attempt.base)
      }
      check()
      attempt.saveRequest ??= {
        workspaceId: attempt.draft.workspaceId, workflowId: attempt.draft.workflowId, draftId: attempt.draft.id,
        commandId: crypto.randomUUID(), expectedRevision: attempt.draft.revision,
      }
      attempt.publication ??= await ports.save(attempt.saveRequest)
      check()
      const saved = attempt.publication
      const savedAgents = saved.value.agents
      const base = captureManagedBase(saved.value.draft,
        [...new Map([...attempt.base.agents, ...savedAgents.map((entry) => entry.agent)].map((agent) => [agent.id, agent])).values()],
        { ...attempt.base.metadataRevisions, ...Object.fromEntries(savedAgents.map((entry) => [entry.agent.id, entry.metadataRevision])) })
      ports.onSaved(attempt, saved, base)
      this.attempts.delete(key)
      this.revertable.delete(key)
      return saved
    }).catch((error: unknown) => {
      if (epoch === this.epoch && definitiveRejection(error)) {
        const attempt = this.attempts.get(key)
        if (attempt?.appliedCommandIds.length) {
          const prior = this.revertable.get(key)
          this.revertable.set(key, {
            draft: attempt.draft,
            applyCommandIds: [...(prior?.applyCommandIds ?? []), ...attempt.appliedCommandIds],
          })
        }
        this.attempts.delete(key)
      }
      throw error
    }).finally(() => {
      if (epoch === this.epoch) { this.flights.delete(key); ports.setSaving(false) }
    })
    this.flights.set(key, task)
    ports.setSaving(true)
    return task
  }
}
export const managedSaveQueue = new ManagedSaveQueue()
