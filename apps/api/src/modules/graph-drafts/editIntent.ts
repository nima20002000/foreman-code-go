import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  GraphDraftV2Schema, GraphEditAdvanceInputSchema, GraphEditDiscardInputSchema,
  GraphEditIntentSchema, GraphEditReadInputSchema, GraphEditReadResultSchema,
  GraphEditStageInputSchema, GraphEditStopSchema, GraphSaveV2ResultSchema, sameWorkflowValue,
  type GraphDraftV2, type GraphEditAdvanceInput, type GraphEditDiscardInput, type GraphEditIntent,
  type GraphEditReadInput, type GraphEditReadResult, type GraphEditRunState, type GraphEditStageInput,
} from '@graphql/contracts/wave25'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { RunManagementService } from '../runs/management.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { lockAgentConfigurations } from '../workspaces/agentConfiguration.js'
import { readAffectedGraphRuns } from './saveAdmission.js'

type Source = 'http' | 'mcp'
type Prepared = { draft: GraphDraftV2; savedWorkflowRevision: number; agentPins: GraphEditIntent['agentPins'] }
type SaveValue = ReturnType<typeof GraphSaveV2ResultSchema.parse>
interface DraftBoundary {
  prepare(client: pg.PoolClient, principal: ManagementPrincipal, input: GraphEditStageInput): Promise<Prepared>
  publish(principal: ManagementPrincipal, source: Source, input: GraphEditIntent['saveInput'], intentId: string): Promise<unknown>
}
const isFinished = (intent: GraphEditIntent) => intent.state === 'saved' || intent.state === 'discarded'
const scope = (intent: GraphEditIntent) => ({ workspaceId: intent.workspaceId, workflowId: intent.workflowId,
  stagedAgentIds: intent.stagedDraft.stagedAgents.filter((item) => item.baseRevision !== null).map((item) => item.agent.id) })
export function sameAffectedSet(intent: Pick<GraphEditIntent, 'affected'>, current: GraphEditRunState[]): boolean {
  // SQL and persisted plans have deterministic Run-ID order; pins, not outcomes, are compared.
  return sameWorkflowValue(intent.affected, current.map((item) => item.pin))
}

/** Durable authoring intent, NOT a new lifecycle/Stop owner. Each transition
 * uses fresh grants. No transaction/ordinary pool lease is held over Stop.
 * The separate session lock serializes advance/discard across tabs/processes;
 * a crash releases it, and the same persisted command identities resume. */
export class GraphEditIntentService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly drafts: DraftBoundary) {}

  private authorize(principal: ManagementPrincipal, input: { workspaceId: string; workflowId: string }, write: boolean) {
    requireAuthorization(principal, 'graph:read', input)
    if (write) {
      requireAuthorization(principal, 'graph:edit', input)
      requireAuthorization(principal, 'graph:save', input)
    }
  }
  private authorizeContent(principal: ManagementPrincipal, intent: GraphEditIntent, write: boolean) {
    this.authorize(principal, intent, write)
    if (intent.stagedDraft.stagedAgents.length || intent.result?.agents?.length) requireAuthorization(principal, 'agents:read', intent)
    for (const pin of intent.affected) requireAuthorization(principal, 'runs:read', pin)
  }
  private authorizeCurrent(principal: ManagementPrincipal, current: GraphEditRunState[]) {
    for (const item of current) requireAuthorization(principal, 'runs:read', item.pin)
  }
  private async transaction<T>(principal: ManagementPrincipal, work: (client: pg.PoolClient, live: ManagementPrincipal) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const live = await readLiveManagementPrincipal(client, principal.id)
      const result = await work(client, live)
      await client.query('commit')
      return result
    } catch (error) { await client.query('rollback'); throw error }
    finally { client.release() }
  }
  private async withLease<T>(principalId: string, intentId: string, work: () => Promise<T>): Promise<T> {
    const pool = new pg.Pool({ ...this.pool.options, max: 1, application_name: 'graphql-edit-intent' })
    const client = await pool.connect().catch(async (error: unknown) => { await pool.end(); throw error })
    const key = `graph-edit-intent:${JSON.stringify([principalId, intentId])}`
    let releaseError: Error | undefined
    try {
      await client.query('select pg_advisory_lock(hashtext($1))', [key])
      return await work()
    } finally {
      try { await client.query('select pg_advisory_unlock(hashtext($1))', [key]) }
      catch { releaseError = new Error('Intent lease unlock failed.') }
      client.release(releaseError)
      await pool.end()
    }
  }
  private async load(client: Pick<pg.PoolClient, 'query'>, principalId: string,
    input: { workspaceId: string; workflowId: string; intentId: string }, lock = false): Promise<GraphEditIntent> {
    const row = await client.query<{ record: unknown }>(`select record from graph_edit_intents
      where id=$1 and principal_id=$2 and workspace_id=$3 and workflow_id=$4${lock ? ' for update' : ''}`,
    [input.intentId, principalId, input.workspaceId, input.workflowId])
    if (!row.rows[0]) throw new DomainError('GRAPH_EDIT_INTENT_NOT_FOUND', 'The private edit intent is unavailable in this scope.', 404)
    const intent = GraphEditIntentSchema.parse(row.rows[0].record)
    if (intent.id !== input.intentId || intent.ownerPrincipalId !== principalId
      || intent.workspaceId !== input.workspaceId || intent.workflowId !== input.workflowId) {
      throw new DomainError('GRAPH_EDIT_INTENT_INVALID', 'The stored edit intent has inconsistent identity.', 409)
    }
    return intent
  }
  private async write(client: Pick<pg.PoolClient, 'query'>, intent: GraphEditIntent) {
    const record = GraphEditIntentSchema.parse({ ...intent, updatedAt: new Date().toISOString() })
    const result = await client.query(`update graph_edit_intents set state=$2,record=$3::jsonb,updated_at=now()
      where id=$1 and principal_id=$4 and workspace_id=$5 and workflow_id=$6`,
    [record.id, record.state, JSON.stringify(record), record.ownerPrincipalId, record.workspaceId, record.workflowId])
    if (result.rowCount !== 1) throw new DomainError('GRAPH_EDIT_INTENT_NOT_FOUND', 'The edit intent disappeared.', 409)
    return record
  }
  private async readback(client: pg.PoolClient, live: ManagementPrincipal, intent: GraphEditIntent): Promise<GraphEditReadResult> {
    this.authorizeContent(live, intent, false)
    const current = await readAffectedGraphRuns(client, scope(intent))
    this.authorizeCurrent(live, current)
    const canStop = current.filter((item) => !item.settled).every((item) => isAuthorized(live, 'runs:stop', item.pin))
    return GraphEditReadResultSchema.parse({ intent, current, canStop, affectedSetChanged: !sameAffectedSet(intent, current) })
  }

  async read(principal: ManagementPrincipal, raw: GraphEditReadInput): Promise<GraphEditReadResult> {
    const input = GraphEditReadInputSchema.parse(raw)
    return this.transaction(principal, async (client, live) => {
      this.authorize(live, input, false)
      let id = input.intentId
      if (!id) {
        // An old draft instance may have been discarded in another tab. Retain
        // its unresolved intent instead of silently hiding it on the new board.
        const row = await client.query<{ id: string }>(`select id from graph_edit_intents
          where principal_id=$1 and workspace_id=$2 and workflow_id=$3
          order by (state not in ('saved','discarded')) desc,created_at desc,id desc limit 1`,
        [live.id, input.workspaceId, input.workflowId])
        id = row.rows[0]?.id
      }
      if (!id) return { intent: null, current: [], canStop: false, affectedSetChanged: false }
      return this.readback(client, live, await this.load(client, live.id, { ...input, intentId: id }))
    })
  }

  async stage(principal: ManagementPrincipal, source: Source, raw: GraphEditStageInput): Promise<GraphEditReadResult> {
    const input = GraphEditStageInputSchema.parse(raw)
    this.authorize(principal, input, true)
    const execution = await this.commands.execute({ principal, source, operation: 'graph.stage_edits', commandId: input.commandId,
      targetKey: `draft:${input.draftId}`, payload: input,
      authorize: async (client) => {
        principal = await readLiveManagementPrincipal(client, principal.id)
        this.authorize(principal, input, true)
      },
      perform: async (client) => {
        // prepare holds the same workspace/workflow locks as Start and Save,
        // applies existing typed operations in memory, and performs no publication.
        const prepared = await this.drafts.prepare(client, principal, input)
        const existing = await client.query<{ id: string }>(`select id from graph_edit_intents
          where principal_id=$1 and workspace_id=$2 and workflow_id=$3 and state not in ('saved','discarded')`,
        [principal.id, input.workspaceId, input.workflowId])
        if (existing.rows[0]) throw new DomainError('GRAPH_EDIT_INTENT_EXISTS',
          'An unresolved edit intent already exists. Read and reconcile it; do not allocate replacement Stop or save commands.', 409)
        const current = await readAffectedGraphRuns(client, { workspaceId: input.workspaceId, workflowId: input.workflowId,
          stagedAgentIds: prepared.draft.stagedAgents.filter((item) => item.baseRevision !== null).map((item) => item.agent.id) })
        this.authorizeCurrent(principal, current)
        const saveInput = { workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId,
          expectedRevision: input.expectedRevision, commandId: randomUUID(), executionSemanticsVersion: 2 as const }
        const id = `graph-edit-${randomUUID()}`, now = new Date().toISOString()
        const advanceCommandId = randomUUID(), discardCommandId = randomUUID()
        const commandScope = { workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId, intentId: id }
        const intent = GraphEditIntentSchema.parse({ id, ownerPrincipalId: principal.id,
          workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId,
          stageCommandId: input.commandId, stageInputHash: commandInputHash(input),
          advanceCommandId, advanceInputHash: commandInputHash({ ...commandScope, action: 'stop_and_save', commandId: advanceCommandId }),
          discardCommandId, discardInputHash: commandInputHash({ ...commandScope, action: 'discard_edits', commandId: discardCommandId }),
          expectedRevision: input.expectedRevision, expectedWorkflowVersionId: input.expectedWorkflowVersionId,
          savedWorkflowRevision: prepared.savedWorkflowRevision, stagedDraft: prepared.draft, agentPins: prepared.agentPins,
          affected: current.map((item) => item.pin), stops: current.filter((item) => !item.settled).map((item) => {
            const stopInput = { workspaceId: item.pin.workspaceId, runId: item.pin.runId, commandId: randomUUID() }
            return { input: stopInput, inputHash: commandInputHash(stopInput) }
          }),
          saveInput, saveInputHash: commandInputHash({ ...saveInput, editIntentId: id }),
          state: 'staged', saveAttempted: false, createdAt: now, updatedAt: now })
        this.authorizeContent(principal, intent, true)
        await client.query(`insert into graph_edit_intents(id,principal_id,workspace_id,workflow_id,draft_id,state,record)
          values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [id, principal.id, input.workspaceId, input.workflowId, input.draftId, intent.state, JSON.stringify(intent)])
        return { intentId: id }
      } })
    // Do not return the stage receipt's old state after a replay.
    return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId, workflowId: input.workflowId,
      draftId: input.draftId, intentId: execution.value.intentId })
  }

  private assertCommand(intent: GraphEditIntent, input: GraphEditAdvanceInput | GraphEditDiscardInput) {
    if (intent.draftId !== input.draftId || input.commandId !== (input.action === 'stop_and_save' ? intent.advanceCommandId : intent.discardCommandId)
      || commandInputHash(input) !== (input.action === 'stop_and_save' ? intent.advanceInputHash : intent.discardInputHash)) {
      throw new DomainError('COMMAND_ID_CONFLICT', 'Reconcile the exact persisted intent command and draft identity.', 409)
    }
  }

  /** Recheck even before stopping. Final publication calls this again under
   * the SAME admission transaction as Agent/version writes. New Runs never
   * expand a stale Stop plan, even if they have subsequently completed. */
  private async fresh(client: pg.PoolClient, live: ManagementPrincipal, intent: GraphEditIntent) {
    this.authorizeContent(live, intent, true)
    await lockActiveWorkspace(client, intent.workspaceId)
    const parent = (await client.query<{ revision: string; current_version_id: string | null; archived_at: Date | null }>(
      'select revision::text,current_version_id,archived_at from workflows where workspace_id=$1 and id=$2 for update',
      [intent.workspaceId, intent.workflowId])).rows[0]
    if (!parent || parent.archived_at) throw new DomainError('WORKFLOW_UNAVAILABLE', 'The workflow is unavailable for publication.', 409)
    if (Number(parent.revision) !== intent.savedWorkflowRevision || parent.current_version_id !== intent.expectedWorkflowVersionId) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The saved workflow changed. The exact staged payload and commands are retained.', 409)
    }
    const row = (await client.query<{ record: unknown }>(`select record from graph_drafts
      where id=$1 and workspace_id=$2 and workflow_id=$3 and discarded_at is null for update`,
    [intent.draftId, intent.workspaceId, intent.workflowId])).rows[0]
    const draft = row ? GraphDraftV2Schema.parse(row.record) : undefined
    if (!draft || draft.revision !== intent.expectedRevision || draft.baseWorkflowVersionId !== intent.expectedWorkflowVersionId) {
      throw new DomainError('REVISION_CONFLICT', 'The shared draft instance or revision changed. The private staged payload is retained.', 409)
    }
    await lockAgentConfigurations(client, intent.agentPins.map((pin) => pin.agentId).sort())
    for (const pin of intent.agentPins) {
      const row = (await client.query<{ workspace_id: string; metadata_revision: string; current_configuration_version_id: string | null; archived_at: Date | null }>(
        'select workspace_id,metadata_revision::text,current_configuration_version_id,archived_at from agents where id=$1 for share',
        [pin.agentId])).rows[0]
      if (pin.metadataRevision === null ? !!row : (!row || row.workspace_id !== intent.workspaceId || row.archived_at !== null
        || Number(row.metadata_revision) !== pin.metadataRevision || row.current_configuration_version_id !== pin.configurationVersionId)) {
        throw new DomainError('AGENT_REVISION_CONFLICT', 'An exact Agent configuration or metadata pin changed. The private staged payload is retained.', 409)
      }
    }
    const current = await readAffectedGraphRuns(client, scope(intent))
    this.authorizeCurrent(live, current)
    if (!sameAffectedSet(intent, current)) throw new DomainError('AFFECTED_RUN_SET_CHANGED',
      'The affected Run/version set changed after planning. No newly discovered Run will be stopped by this intent.', 409)
    return current
  }

  async advance(principal: ManagementPrincipal, source: Source, raw: GraphEditAdvanceInput,
    stop: RunManagementService['stop']): Promise<GraphEditReadResult> {
    const input = GraphEditAdvanceInputSchema.parse(raw)
    return this.withLease(principal.id, input.intentId, async () => {
      let intent = await this.transaction(principal, async (client, live) => {
        const value = await this.load(client, live.id, input)
        this.authorizeContent(live, value, true); this.assertCommand(value, input)
        return value
      })
      if (isFinished(intent)) return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId, intentId: input.intentId })
      try {
        // A save may already have committed; never revisit Stop before its
        // exact receipt is reconciled. The save receipt and saved journal state
        // commit together, so a read after a lost reply is sufficient too.
        if (!intent.saveAttempted) {
          await this.transaction(principal, async (client, live) => {
            const current = await this.fresh(client, live, intent)
            for (const item of current.filter((item) => !item.settled)) requireAuthorization(live, 'runs:stop', item.pin)
            intent = await this.write(client, { ...intent, state: 'stopping', error: undefined })
            return current
          })
          for (let index = 0; index < intent.stops.length; index++) {
            const entry = intent.stops[index]!
            const live = await this.transaction(principal, async (client, live) => {
              const current = await this.fresh(client, live, intent)
              for (const item of current.filter((item) => !item.settled)) requireAuthorization(live, 'runs:stop', item.pin)
              return { principal: live, settled: current.find((item) => item.pin.runId === entry.input.runId)?.settled === true }
            })
            if (commandInputHash(entry.input) !== entry.inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'The Stop input hash is inconsistent.', 409)
            // This is the existing Stop service, with its exact coordinator,
            // native/owner gates and receipt. No direct lifecycle SQL exists here.
            let stopError: unknown
            // Natural completion needs no new Stop, but a reply lost before
            // settlement may already have a durable receipt. Read it either way.
            if (!live.settled) {
              try { await stop(live.principal, source, entry.input) } catch (error) { stopError = error }
            }
            const receipt = await this.pool.query<{ input_hash: string; target_key: string; result: unknown }>(`select input_hash,target_key,result
              from management_command_receipts where principal_id=$1 and operation='run.stop' and command_id=$2`,
            [principal.id, entry.input.commandId])
            const row = receipt.rows[0]
            if (!row && live.settled) continue
            if (!row) throw stopError ?? new Error('Stop acknowledgement is uncertain; its exact command is retained.')
            if (row.input_hash !== entry.inputHash || row.target_key !== `run:${entry.input.runId}`) {
              throw new DomainError('COMMAND_ID_CONFLICT', 'The Stop receipt contradicts the exact planned command.', 409)
            }
            const parsed = GraphEditStopSchema.shape.receipt.unwrap().parse(row.result)
            if (parsed.runId !== entry.input.runId || (entry.receipt && !sameWorkflowValue(entry.receipt, parsed))) {
              throw new DomainError('COMMAND_ID_CONFLICT', 'Contradictory Stop receipt evidence is retained, never overwritten.', 409)
            }
            intent = await this.transaction(principal, async (client, live) => {
              this.authorizeContent(live, intent, true)
              return this.write(client, { ...intent, stops: intent.stops.map((item, i) => i === index ? { ...item, receipt: parsed } : item) })
            })
          }
        }
        const ready = await this.transaction(principal, async (client, live) => {
          const current = await this.fresh(client, live, intent)
          const settled = current.every((item) => item.settled)
          intent = await this.write(client, { ...intent, state: settled ? 'saving' : 'waiting',
            saveAttempted: intent.saveAttempted || settled, error: undefined })
          return settled
        })
        if (ready) await this.drafts.publish(principal, source, intent.saveInput, intent.id)
      } catch (error) {
        // Domain rejections are known non-publications. Transport/database
        // failures can have committed: retain the exact save command and read
        // durable state before recording uncertainty, never overwrite success.
        await this.transaction(principal, async (client, live) => {
          const latest = await this.load(client, live.id, input, true)
          this.authorizeContent(live, latest, true)
          if (isFinished(latest)) return
          const uncertain = !(error instanceof DomainError)
          await this.write(client, { ...latest, state: uncertain ? 'uncertain' : 'blocked',
            error: { code: error instanceof DomainError ? error.code : 'COMMAND_UNCERTAIN',
              message: error instanceof DomainError ? error.message : 'The reply is uncertain. Reconcile this exact intent; its payload and command identities are retained.', uncertain } })
          await this.commands.recordAudit(live.id, source, 'graph.stop_and_save', `edit-intent:${latest.id}`,
            uncertain ? 'uncertain' : 'failed', { commandId: input.commandId,
              code: error instanceof DomainError ? error.code : 'COMMAND_UNCERTAIN' }, client)
        }).catch(() => undefined) // Revocation withholds readback; it must not delete the intent.
        if (error instanceof DomainError && (error.code === 'ACCESS_DENIED' || error.code.startsWith('AUTH_'))) throw error
      }
      return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId,
        workflowId: input.workflowId, draftId: input.draftId, intentId: input.intentId })
    })
  }

  async discard(principal: ManagementPrincipal, source: Source, raw: GraphEditDiscardInput): Promise<GraphEditReadResult> {
    const input = GraphEditDiscardInputSchema.parse(raw)
    return this.withLease(principal.id, input.intentId, async () => {
      await this.transaction(principal, async (client, live) => {
        const intent = await this.load(client, live.id, input, true)
        this.authorizeContent(live, intent, false)
        requireAuthorization(live, 'graph:edit', input)
        this.assertCommand(intent, input)
        if (intent.state === 'discarded') return
        if (intent.state === 'saved') throw new DomainError('GRAPH_EDIT_ALREADY_SAVED', 'This intent already published. Read its saved result before editing again.', 409)
        if (intent.saveAttempted && intent.state !== 'blocked') throw new DomainError('GRAPH_EDIT_SAVE_UNCERTAIN',
          'Reconcile the exact save command before discarding; its publication outcome is uncertain.', 409)
        await this.write(client, { ...intent, state: 'discarded', error: undefined })
        await this.commands.recordAudit(live.id, source, 'graph.discard_edits', `edit-intent:${intent.id}`,
          'succeeded', { commandId: input.commandId }, client)
      })
      // No Stop, shared draft mutation or layout mutation occurs on this path.
      return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId,
        workflowId: input.workflowId, draftId: input.draftId, intentId: input.intentId })
    })
  }

  async authorizeSave(client: pg.PoolClient, live: ManagementPrincipal, intentId: string,
    input: { workspaceId: string; workflowId: string }) {
    this.authorizeContent(live, await this.load(client, live.id, { ...input, intentId }), true)
  }

  /** Internal-only save admission, called inside GraphDraftService.save's
   * transaction BEFORE any Agent or version write. Public callers cannot pass
   * this context through the strict ordinary graph_save schema. */
  async publication(client: pg.PoolClient, live: ManagementPrincipal, intentId: string,
    input: GraphEditIntent['saveInput']): Promise<GraphDraftV2> {
    const intent = await this.load(client, live.id, { ...input, intentId }, true)
    this.authorizeContent(live, intent, true)
    if (intent.state !== 'saving' || !intent.saveAttempted || !sameWorkflowValue(input, intent.saveInput)
      || commandInputHash({ ...input, editIntentId: intent.id }) !== intent.saveInputHash) {
      throw new DomainError('GRAPH_EDIT_INTENT_CONFLICT', 'The exact staged publication command is not ready.', 409)
    }
    const current = await this.fresh(client, live, intent)
    if (current.some((item) => !item.settled)) throw new DomainError('WORKFLOW_RUNS_UNSETTLED',
      'Affected work is not fully settled. The exact payload and command identities remain staged.', 409)
    return intent.stagedDraft
  }
  async saved(client: pg.PoolClient, live: ManagementPrincipal, intentId: string, value: SaveValue) {
    const intent = await this.load(client, live.id, { workspaceId: value.draft.workspaceId,
      workflowId: value.draft.workflowId, intentId }, true)
    if (intent.state !== 'saving') throw new DomainError('GRAPH_EDIT_INTENT_CONFLICT', 'The staged publication changed.', 409)
    await this.write(client, { ...intent, state: 'saved', result: GraphSaveV2ResultSchema.parse(value), error: undefined })
  }
}
