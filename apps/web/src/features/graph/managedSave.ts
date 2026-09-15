import type { GraphDraft, GraphDraftOperation } from '@graphql/contracts/management'
import type { applyManagedGraphDraft, saveManagedGraphDraft } from '../../shared/api/client'
import type { GraphSaveSnapshot } from './store'
import { captureManagedBase, type ManagedEditBase } from './managedGraphState'

export const GRAPH_APPLY_BATCH_SIZE = 100
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
  private readonly flights = new Map<string, Promise<ManagedPublication>>()
  private epoch = 0
  isRunning(key: string): boolean { return this.flights.has(key) }
  hasPending(key: string): boolean { return this.attempts.has(key) }
  discard(key: string): void {
    if (this.isRunning(key)) throw new Error('A save is still in progress. Local edits cannot be discarded yet.')
    if (this.attempts.has(key)) throw new Error('Retry Save graph to resolve the previous request, then discard any remaining local edits.')
  }
  reset(): void { ++this.epoch; this.attempts.clear(); this.flights.clear() }

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
        attempt = { ...plan, draft: plan.base.draft, nextOperation: 0 }
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
      return saved
    }).catch((error: unknown) => {
      if (epoch === this.epoch && definitiveRejection(error)) this.attempts.delete(key)
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
