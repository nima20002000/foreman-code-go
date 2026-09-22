import { createHash } from 'node:crypto'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution, type ExecutionResult } from '@graphql/contracts'
import {
  WorkflowRunV2Schema, WorkflowVersionV2Schema, RunGraphScopeSchema, ExecutableWorkflowV2Schema, canonicalGraphJson, RUN_GRAPH_LIMITS,
  type GraphEffect, type GraphEffectAuthority, type GraphFact, type NodeResolution,
  type RunGraphScope, type WorkflowVersionV2,
} from '@graphql/contracts/wave25'

import type { RunStateUpdate } from './port.js'
import { publicNodeLifecycle } from '../run-graph/publicLifecycle.js'
import { readPublicNodeProjection, publicNodeProjectionDelta, publicRunClosedFacts } from '../run-graph/publicProjection.js'
import { publicAttentionTotals, readPublicAttentionCounts } from '../run-graph/currentAttention.js'
import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import {
  graphSourceDigest, openRunGraphPublication,
  type GraphEffectGuard, type RunGraphPublication,
} from '../run-graph/publication.js'
import { putInputBinding, putNodeResolution, readNodeResolutions } from '../run-graph/records.js'
import type { RunOwnership } from './ownership.js'
import {
  assertOneShotExecutionPin, bindOneShotInput, inactiveOneShotResolution,
  normalizeOneShotTerminal, oneShotIdentity, oneShotResolution,
} from './oneShotResolution.js'
import { compileOneShotTopology, decideOneShotAdmission, selectedTerminalResolutions } from './topology.js'

type OneShotRun = ReturnType<typeof WorkflowRunV2Schema.parse>
interface ExecutionRow { id: string; record: unknown; accepted: boolean }
interface Context {
  sql: GraphTransactionSql
  publication: RunGraphPublication
  scope: RunGraphScope
  run: OneShotRun
  version: WorkflowVersionV2
  resolutions: Map<string, NodeResolution>
  executions: Map<string, { execution: HarnessExecution; accepted: boolean }>
  stopped: boolean
}
export type OneShotAdmission =
  | { kind: 'waiting' }
  | { kind: 'resolved'; resolution: NodeResolution }
  | { kind: 'admitted'; execution: HarnessExecution; reused: boolean }

function stableId(kind: string, ...parts: string[]): string {
  return `${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}
function conflict(code: string, message: string): never { throw new DomainError(code, message, 409) }

/**
 * Durable one-shot bookkeeping on the SAME dedicated Run-owner session.
 *
 * Lock order: Run (open publication), graph head, executions in ID order,
 * immutable resolutions / receipts. Queries and the entire transaction are serialized.
 * There is no filesystem, credentials, native dispatch, capacity wait, or network
 * callback inside this repository. The v2 admission gate is not enabled here.
 */
export class OneShotRunRepository {
  private readonly launchPermits = new Set<string>()
  constructor(private readonly owner: RunOwnership,
    private readonly authorizeLaunch?: (sql: GraphTransactionSql, run: OneShotRun) => Promise<void>) {}

  /** One-use in-memory capability issued ONLY by a confirmed claim commit below.
   * A receipt read after restart is not a capability to submit again. */
  consumeLaunchPermit(executionId: string): boolean {
    this.owner.assertOwned()
    return this.launchPermits.delete(executionId)
  }

  private async transaction<T>(work: (context: Context) => Promise<T>): Promise<T> {
    const connection = this.owner.oneShotConnection()
    return connection.transaction(async (sql) => {
      this.owner.assertOwned()
      // This initial read is only scope discovery. Re-read domain records AFTER
      // openRunGraphPublication obtains the parent/head locks.
      const initial = await sql.query<{ record: unknown }>('select record from runs where id=$1', [this.owner.runId])
      const found = initial.rows[0]
      if (!found) return conflict('RUN_NOT_FOUND', 'The Run no longer exists.')
      const discovery = WorkflowRunV2Schema.parse(found.record)
      const scope = RunGraphScopeSchema.parse({
        workspaceId: discovery.workspaceId, workflowId: discovery.workflowId, runId: discovery.id,
        workflowVersionId: discovery.workflowVersionId, executionSemanticsVersion: 2,
      })
      // Head initialization is deliberately the Run-admission writer's job. An
      // existing Run cannot silently claim complete history from admission.
      const publication = await openRunGraphPublication(sql, scope)
      await this.owner.readOneShotFence(sql)
      const rows = await sql.query<{ run: unknown; version: unknown; stopped: boolean }>(
        `select r.record as run,v.record as version,r.stop_requested_at is not null as stopped
         from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [scope.runId],
      )
      const row = rows.rows[0]
      if (!row) return conflict('RUN_PIN_MISSING', 'The immutable Run version is unavailable.')
      const run = WorkflowRunV2Schema.parse(row.run)
      const version = WorkflowVersionV2Schema.parse(row.version)
      if (run.id !== scope.runId || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
        || run.workflowVersionId !== version.id || version.id !== scope.workflowVersionId
        || graphSourceDigest(run.agentConfigurationVersionIds) !== graphSourceDigest(version.agentConfigurationVersionIds)
        || graphSourceDigest(run.approval) !== graphSourceDigest(version.approval)) {
        return conflict('RUN_PIN_CONFLICT', 'The Run does not match its immutable configuration pins.')
      }
      // All child writers in this lane lock in this deterministic order. The
      // one-shot bound is 1000 executions, not an unbounded history scan.
      const stored = await sql.query<ExecutionRow>(
        'select id,record,accepted from harness_executions where run_id=$1 order by id limit 1001 for update', [run.id],
      )
      if (stored.rows.length > 1000) return conflict('WORKFLOW_REPEAT_UNSUPPORTED', 'One-shot execution bounds were exceeded.')
      const executions = new Map<string, { execution: HarnessExecution; accepted: boolean }>()
      const nodes = new Set<string>()
      for (const item of stored.rows) {
        const execution = HarnessExecutionSchema.parse(item.record)
        assertOneShotExecutionPin(version, execution)
        if (execution.runId !== run.id || execution.id !== item.id || nodes.has(execution.workflowNodeId)) {
          return conflict('EXECUTION_OCCURRENCE_CONFLICT', 'The Run contains a conflicting one-shot execution.')
        }
        nodes.add(execution.workflowNodeId)
        executions.set(execution.id, { execution, accepted: item.accepted })
      }
      const resolutions = new Map((await readNodeResolutions(sql, scope)).map((item) => [item.workflowNodeId, item]))
      return work({ sql, publication, scope, run, version, resolutions, executions, stopped: row.stopped })
    })
  }

  /** All effects are database intents under the actual Run-owner session lock.
   * Native session mutation still requires the existing SingleWriterSessionManager.
   * The first launch has no session generation; recovery NEVER uses this guard
   * to authorize a replacement session or a second native submission. */
  private async guard(context: Context, effect: GraphEffect, closingNegative = false): Promise<GraphEffectGuard> {
    const expected = {
      scope: context.scope, effect: effect.identity, effectDigest: effect.digest,
      ...await this.owner.readOneShotFence(context.sql), connectionGeneration: null,
    }
    return {
      expected,
      readCurrentLocked: async (sql, scope, identity): Promise<GraphEffectAuthority> => {
        if (!['result.accept', 'route.resolve', 'input.bind', 'execution.launch'].includes(identity.kind)) {
          return conflict('GRAPH_EFFECT_ACCESS_DENIED', 'This repository has no native or approval dispatch authority.')
        }
        const current = await sql.query<{ record: unknown; stopped: boolean }>(
          'select record,stop_requested_at is not null as stopped from runs where id=$1', [scope.runId],
        )
        const row = current.rows[0]
        if (!row) return conflict('RUN_NOT_FOUND', 'The Run no longer exists.')
        const run = WorkflowRunV2Schema.parse(row.record)
        const actualScope = RunGraphScopeSchema.parse({
          workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
          workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 2,
        })
        // Closing an existing negative execution is a Run-owner duty even
        // after its user's native permissions are revoked. It selects no routes,
        // starts no work and cannot accept success. All activating effects need
        // the live accepted permission ceiling retained through COMMIT.
        if (!closingNegative) await this.assertLiveAuthorization(context)
        const scoped = graphSourceDigest(actualScope) === graphSourceDigest(context.scope)
          && graphSourceDigest(run.agentConfigurationVersionIds) === graphSourceDigest(context.version.agentConfigurationVersionIds)
        return {
          scope: actualScope, effect: identity, effectDigest: effect.digest,
          ...await this.owner.readOneShotFence(sql), connectionGeneration: null,
          ownership: 'held', access: 'effect', security: scoped ? 'valid' : 'invalid',
          effectClosed: row.stopped || ['completed', 'interrupted'].includes(run.executionState),
          submission: identity.kind === 'execution.launch' ? await this.launchSubmission(context, identity.entityId) : 'unknown',
        }
      },
    }
  }

  private async effect(
    context: Context, kind: 'result.accept' | 'route.resolve' | 'input.bind' | 'execution.launch', entityId: string,
    value: unknown, facts: GraphFact[], mutate: (sql: GraphTransactionSql) => Promise<void>,
  ): Promise<void> {
    const digest = graphSourceDigest(value)
    const effect: GraphEffect = { identity: { kind, entityId }, digest }
    await context.publication.effect({
      effect, sourceDigest: digest,
      evidence: { sourceKind: kind === 'input.bind' ? 'input_binding' : kind === 'route.resolve' ? 'node_resolution' : 'execution',
        sourceId: stableId('a3', context.run.id, kind, entityId), sourceRevision: '1' },
      facts,
    }, await this.guard(context, effect, kind === 'route.resolve' && typeof value === 'object' && value !== null
      && 'resolution' in value && ['failed', 'canceled'].includes(String(value.resolution))), mutate)
  }

  /** Persist excluded/zero-selected wrappers without constructing a native execution. */
  private async resolveInactive(context: Context, nodeId: string, kind: 'excluded' | 'skipped'): Promise<NodeResolution> {
    const existing = context.resolutions.get(nodeId)
    if (existing) return existing
    const resolution = inactiveOneShotResolution(context.version, nodeId, kind, new Date().toISOString())
    const facts: GraphFact[] = [{ type: 'node.resolved', resolution }]
    if (kind === 'skipped') facts.push({ type: 'node.state', state: { workflowNodeId: nodeId, lifecycle: publicNodeLifecycle(undefined, undefined, resolution.resolution) } })
    await this.effect(context, 'route.resolve', nodeId, resolution, facts,
      async (sql) => { await putNodeResolution(sql, context.scope, resolution) })
    return resolution
  }

  /** The candidate is a record only; the caller MUST NOT allocate its runtime before this commit. */
  async admit(nodeId: string, candidate: () => HarnessExecution): Promise<OneShotAdmission> {
    return this.transaction<OneShotAdmission>(async (context) => {
      this.assertActive(context)
      const topology = compileOneShotTopology(context.version)
      const decision = decideOneShotAdmission(topology, nodeId, context.resolutions)
      if (decision.kind === 'resolved') return { kind: 'resolved', resolution: decision.resolution }
      if (decision.kind === 'waiting') return { kind: 'waiting' }
      if (decision.kind === 'excluded' || decision.kind === 'skipped') {
        return { kind: 'resolved', resolution: await this.resolveInactive(context, nodeId, decision.kind) }
      }
      const existing = [...context.executions.values()].find((item) => item.execution.workflowNodeId === nodeId)
      if (existing) return { kind: 'admitted', execution: existing.execution, reused: true }
      const parsed = HarnessExecutionSchema.parse(candidate())
      assertOneShotExecutionPin(context.version, parsed)
      if (parsed.runId !== context.run.id || parsed.workflowNodeId !== nodeId || parsed.state !== 'queued'
        || parsed.runtimeDirectory !== undefined || parsed.workingDirectory !== undefined || parsed.nativeSessionId !== undefined || parsed.result !== undefined
        || parsed.startedAt !== undefined || parsed.finishedAt !== undefined) {
        return conflict('EXECUTION_ADMISSION_INVALID', 'Queue admission cannot contain native resources or terminal evidence.')
      }
      const { execution, bindings } = bindOneShotInput({
        version: context.version, runInput: context.run.input, recipient: parsed,
        resolutions: context.resolutions, predecessors: context.executions, boundAt: new Date().toISOString(),
      })
      const facts: GraphFact[] = [{ type: 'node.state', state: {
        workflowNodeId: nodeId, execution: oneShotIdentity(execution), lifecycle: publicNodeLifecycle(execution.state, execution.result?.outcome),
      } }, ...bindings.map((binding): GraphFact => ({ type: 'input.bound', binding }))]
      await this.effect(context, 'input.bind', execution.id, { execution, bindings }, facts, async (sql) => {
        await sql.query(
          `insert into harness_executions (id,run_id,workflow_node_id,agent_id,attempt,record)
           values ($1,$2,$3,$4,1,$5::jsonb)`,
          [execution.id, execution.runId, nodeId, execution.agentId, JSON.stringify(execution)],
        )
        for (const binding of bindings) await putInputBinding(sql, context.scope, binding)
      })
      return { kind: 'admitted', execution, reused: false }
    })
  }

  async resolveExcluded(): Promise<void> {
    // One bounded transaction per excluded node avoids a wide board retaining an
    // oversized pending publication. No artificial handoff or queued fact occurs.
    const excluded = await this.transaction(async (context) => compileOneShotTopology(context.version).excluded)
    for (const nodeId of excluded) {
      await this.transaction(async (context) => { await this.resolveInactive(context, nodeId, 'excluded') })
    }
  }

  /**
   * Re-read durable terminal evidence; a caller's stale copy cannot overwrite it.
   * Accept success and resolve routes in ONE transaction. On crash before commit
   * both roll back; after commit both replay, with no native submission involved.
   */
  async acceptTerminal(executionId: string): Promise<NodeResolution> {
    return this.transaction(async (context) => {
      const row = context.executions.get(executionId)
      if (!row) return conflict('EXECUTION_NOT_FOUND', 'The exact receiving execution is unavailable.')
      const prior = context.resolutions.get(row.execution.workflowNodeId)
      if (prior) {
        if (prior.execution?.executionId !== executionId) return conflict('EXECUTION_OCCURRENCE_CONFLICT', 'Another identity already resolved this node.')
        return prior
      }
      if (context.stopped || context.run.executionState === 'interrupted') return conflict('GRAPH_STOP_CONFLICT', 'Stopped or interrupted work cannot accept a new result.')
      const execution = normalizeOneShotTerminal(context.version, row.execution)
      if (row.accepted && graphSourceDigest(execution) !== graphSourceDigest(row.execution)) {
        return conflict('EXECUTION_ACCEPTED_RESULT_CONFLICT', 'An already accepted result cannot be rewritten to repair history.')
      }
      const resolution = oneShotResolution(context.version, execution)
      const facts: GraphFact[] = [{ type: 'node.resolved', resolution }, { type: 'node.state', state: {
        workflowNodeId: execution.workflowNodeId, execution: oneShotIdentity(execution),
        lifecycle: publicNodeLifecycle(execution.state, execution.result?.outcome, resolution.resolution),
      } }]
      if (resolution.resolution === 'succeeded') facts.unshift({
        type: 'result.accepted', execution: oneShotIdentity(execution), resultDigest: resolution.acceptedResultDigest!,
      })
      if (resolution.resolution === 'succeeded') {
        await this.effect(context, 'result.accept', execution.id, execution,
          [{ type: 'result.accepted', execution: oneShotIdentity(execution), resultDigest: resolution.acceptedResultDigest! }], async (sql) => {
            await sql.query('update harness_executions set record=$2::jsonb,accepted=true where id=$1 and run_id=$3',
              [execution.id, JSON.stringify(execution), context.run.id])
          })
      }
      await this.effect(context, 'route.resolve', execution.workflowNodeId, resolution,
        facts.filter((fact) => fact.type !== 'result.accepted'), async (sql) => {
          if (resolution.resolution !== 'succeeded') await sql.query('update harness_executions set record=$2::jsonb where id=$1 and run_id=$3',
            [execution.id, JSON.stringify(execution), context.run.id])
          await putNodeResolution(sql, context.scope, resolution)
        })
      return resolution
    })
  }

  async readResolutions(): Promise<Map<string, NodeResolution>> {
    return this.transaction(async (context) => context.resolutions)
  }

  async selectedTerminalResults(): Promise<Array<{ workflowNodeId: string; executionId: string; result: NonNullable<HarnessExecution['result']> }>> {
    return this.transaction(async (context) => {
      const topology = compileOneShotTopology(context.version)
      if (topology.order.some((id) => !context.resolutions.has(id))) {
        return conflict('WORKFLOW_UNRESOLVED', 'Every reachable path must resolve before successful completion.')
      }
      if (topology.order.some((id) => ['failed', 'canceled'].includes(context.resolutions.get(id)!.resolution))) {
        return conflict('WORKFLOW_NOT_SUCCESSFUL', 'An unsuccessful path cannot become a successful Run.')
      }
      return selectedTerminalResolutions([...context.resolutions.values()]).map((resolution) => {
        const row = context.executions.get(resolution.execution!.executionId)
        if (!row?.accepted || row.execution.result?.outcome !== 'succeeded'
          || graphSourceDigest(row.execution.result) !== resolution.acceptedResultDigest) {
          return conflict('EXECUTION_INPUT_NOT_ACCEPTED', 'A selected terminal requires its exact accepted result.')
        }
        return { workflowNodeId: resolution.workflowNodeId, executionId: row.execution.id, result: row.execution.result }
      })
    })
  }

  private assertActive(context: Context): void {
    if (context.stopped) conflict('GRAPH_STOP_CONFLICT', 'The Run has a durable Stop request.')
    if (['completed', 'interrupted'].includes(context.run.executionState)) conflict('GRAPH_TERMINAL_CONFLICT', 'The Run cannot produce new execution effects.')
  }

  /** Freeze the existing accepted Run authority and its root owner until COMMIT.
   * The existing authorization helper checks the accepted ceiling and live grants;
   * these row locks ensure revocation cannot race past that check in this transaction.
   * This acquires no new principal, credential, runtime owner or native permission.
   */
  private async assertLiveAuthorization(context: Context): Promise<void> {
    const id = context.run.authorizationPrincipalId
    if (!id) return // only internally seeded/uncredentialed fixtures have no authority pin
    if (!this.authorizeLaunch) conflict('GRAPH_SECURITY_UNQUALIFIED', 'Live Run authorization must be revalidated.')
    await context.sql.query(`select principal_id from run_authority_principals
      where principal_id=$1 and run_id=$2 for share`, [id, context.run.id])
    await context.sql.query(`select p.id from management_principals p where p.id=$1
      or p.id=(select owner_principal_id from run_authority_principals where principal_id=$1 and run_id=$2)
      order by p.id for share`, [id, context.run.id])
    await this.authorizeLaunch!(context.sql, context.run)
  }

  private async launchSubmission(context: Context, executionId: string): Promise<'not_submitted' | 'uncertain'> {
    const row = context.executions.get(executionId)
    if (!row || row.execution.state !== 'queued' || row.execution.nativeSessionId) return 'uncertain'
    const claimed = await context.sql.query(
      "select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch' and entity_id=$2",
      [context.run.id, executionId],
    )
    return claimed.rowCount ? 'uncertain' : 'not_submitted'
  }

  /** Queue admission != dispatch. Claim under Run/head/child locks AFTER capacity.
   * A claim is conservatively uncertain as soon as it commits. No network or
   * filesystem work happens here; every recovery path reconciles the exact ID.
   */
  async claimLaunch(executionId: string, paths: { workingDirectory: string; runtimeDirectory: string }): Promise<HarnessExecution | undefined> {
    const execution = await this.transaction(async (context) => {
      this.assertActive(context)
      if (await this.launchSubmission(context, executionId) !== 'not_submitted') return undefined
      const row = context.executions.get(executionId)!
      await this.assertLiveAuthorization(context)
      // Read actual immutable configuration records, not a caller-supplied role/security bit.
      const configs = await context.sql.query<{ record: unknown }>(
        'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id for share',
        [context.scope.workspaceId, Object.values(context.version.agentConfigurationVersionIds)],
      )
      const configurations = configs.rows.map((item) => AgentConfigurationVersionSchema.parse(item.record))
      ExecutableWorkflowV2Schema.parse({ version: context.version, configurations })
      for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, context.run.approval,
        context.run.approval?.handler === 'orchestrator' && configuration.agentId === context.run.approval.designatedOrchestratorAgentId)
      if (!context.run.executionLocation || paths.workingDirectory !== context.run.executionLocation.rootPath) {
        return conflict('RUN_LOCATION_MISSING', 'Launch must use the immutable accepted Run location.')
      }
      const next = HarnessExecutionSchema.parse({ ...row.execution, ...paths, state: 'starting', startedAt: new Date().toISOString() })
      await this.effect(context, 'execution.launch', executionId, next,
        [{ type: 'node.state', state: { workflowNodeId: next.workflowNodeId, execution: oneShotIdentity(next), lifecycle: publicNodeLifecycle(next.state, next.result?.outcome) } }],
        async (sql) => { await sql.query('update harness_executions set record=$2::jsonb where id=$1', [executionId, JSON.stringify(next)]) })
      return next
    })
    // Never issue the permit before COMMIT, including an unknown COMMIT outcome.
    if (execution) this.launchPermits.add(executionId)
    return execution
  }

  /** Repair the narrow crash between bindWorkflowSession and execution update.
   * Never create, choose between, replace, or start a native session here. */
  async recoverSession(executionId: string): Promise<HarnessExecution> {
    return this.transaction(async (context) => {
      this.assertActive(context)
      const row = context.executions.get(executionId)
      if (!row) return conflict('EXECUTION_NOT_FOUND', 'The execution is unavailable.')
      if (row.execution.state === 'completed') return row.execution
      const native = await context.sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [executionId])
      const reference = native.rows[0] ? NativeSessionReferenceSchema.parse(native.rows[0].reference) : undefined
      if (row.execution.nativeSessionId && row.execution.nativeSessionId !== reference?.nativeSessionId) {
        return conflict('NATIVE_SESSION_IDENTITY_MISMATCH', 'The recorded execution/session bindings disagree.')
      }
      if (!reference || row.execution.nativeSessionId) return row.execution
      const next = HarnessExecutionSchema.parse({ ...row.execution, nativeSessionId: reference.nativeSessionId })
      // Repairing a session binding is not native progress and does not change
      // the public lifecycle. Keep the same graph-visible state at the same head.
      await context.sql.query('update harness_executions set record=$2::jsonb where id=$1', [executionId, JSON.stringify(next)])
      return next
    })
  }

  async exactSession(executionId: string) {
    return this.transaction(async (context) => {
      this.assertActive(context)
      const execution = context.executions.get(executionId)?.execution
      if (!execution?.nativeSessionId) return conflict('NATIVE_SESSION_START_UNCERTAIN', 'Recovery requires a durable exact native session.')
      const rows = await context.sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [executionId])
      const session = NativeSessionReferenceSchema.parse(rows.rows[0]?.reference)
      const configs = await context.sql.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id=$1 and workspace_id=$2 and agent_id=$3',
        [execution.agentConfigurationVersionId, context.scope.workspaceId, execution.agentId])
      const configuration = AgentConfigurationVersionSchema.parse(configs.rows[0]?.record)
      if (session.nativeSessionId !== execution.nativeSessionId || session.harness !== configuration.harness.harness) {
        return conflict('NATIVE_SESSION_IDENTITY_MISMATCH', 'Recovery cannot substitute a session, provider or configuration.')
      }
      return session
    })
  }

  /** Last SQL check before a native boundary; no DB transaction spans native I/O.
   * Stop committed before this check prevents the call. A call already in flight
   * when Stop commits is canceled/reconciled, never described as not submitted. */
  async assertNativeBoundary(executionId: string): Promise<void> {
    await this.transaction(async (context) => {
      this.assertActive(context)
      await this.owner.readOneShotFence(context.sql)
      await this.assertLiveAuthorization(context)
      const execution = context.executions.get(executionId)?.execution
      if (!execution || execution.state === 'completed') conflict('GRAPH_TERMINAL_CONFLICT', 'This execution cannot submit native work.')
      const claim = await context.sql.query(
        "select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch' and entity_id=$2", [context.run.id, executionId])
      if (claim.rowCount !== 1) conflict('GRAPH_EFFECT_ACCESS_DENIED', 'Native work requires its committed first-launch intent.')
    })
  }

  /** Called by the EXISTING native coordinator with its exact-session evidence.
   * Session-manager leases fence native writes; this fences domain writes using
   * current Run ownership, immutable identity/input and monotonic terminal state.
   */
  async updateExecution(input: HarnessExecution): Promise<void> {
    await this.transaction(async (context) => {
      const row = context.executions.get(input.id)
      if (!row) return conflict('EXECUTION_NOT_FOUND', 'A native writer cannot create a new execution occurrence.')
      const previous = row.execution
      let next = HarnessExecutionSchema.parse(input)
      const immutable = (value: HarnessExecution) => ({ identity: oneShotIdentity(value), runId: value.runId,
        input: value.input, createdAt: value.createdAt, workingDirectory: value.workingDirectory, runtimeDirectory: value.runtimeDirectory })
      // JSON.stringify strips only absent optional properties before canonical hashing.
      if (canonicalGraphJson(JSON.parse(JSON.stringify(immutable(previous)))) !== canonicalGraphJson(JSON.parse(JSON.stringify(immutable(next))))
        || (previous.nativeSessionId && next.nativeSessionId !== previous.nativeSessionId)) {
        return conflict('EXECUTION_OCCURRENCE_CONFLICT', 'A stale writer cannot replace execution/session/input identity.')
      }
      if (previous.state === 'completed') {
        if (canonicalGraphJson(previous) !== canonicalGraphJson(next)) conflict('GRAPH_TERMINAL_CONFLICT', 'Terminal evidence is immutable.')
        return
      }
      if (context.stopped || ['completed', 'interrupted'].includes(context.run.executionState)) {
        conflict('GRAPH_STOP_CONFLICT', 'Late native writes cannot resurrect a stopped or terminal Run.')
      }
      if (next.nativeSessionId) {
        const native = await context.sql.query<{ reference: unknown }>(
          'select reference from execution_native_sessions where execution_id=$1 for share', [next.id])
        if (NativeSessionReferenceSchema.parse(native.rows[0]?.reference).nativeSessionId !== next.nativeSessionId) {
          conflict('NATIVE_SESSION_IDENTITY_MISMATCH', 'Native evidence must match the durable exact session.')
        }
      }
      if (next.result?.outcome === 'succeeded' && !next.nativeSessionId) conflict('NATIVE_TERMINAL_EVIDENCE_MISSING', 'Success requires the exact native session.')
      next = normalizeOneShotTerminal(context.version, next)
      if (canonicalGraphJson(previous) === canonicalGraphJson(next)) return
      // Lifecycle, activity and telemetry change atomically with the execution.
      // The same current-record projection serves a fresh snapshot at this head.
      const ids = [next.workflowNodeId]
      const before = await readPublicNodeProjection(context.sql, context.scope, ids)
      const after = await readPublicNodeProjection(context.sql, context.scope, ids, { executions: [next] })
      const facts = publicNodeProjectionDelta(before, after)
      if (!facts.length) {
        // Exact native binding is internal domain bookkeeping; no fake work event.
        await context.sql.query('update harness_executions set record=$2::jsonb where id=$1', [next.id, JSON.stringify(next)])
        return
      }
      await this.source(context, 'execution', next.id, { previous, next }, facts, async () => {
        await context.sql.query('update harness_executions set record=$2::jsonb where id=$1', [next.id, JSON.stringify(next)])
      })
    })
  }

  private async source(context: Context, kind: 'run' | 'execution' | 'cleanup', id: string, value: unknown,
    facts: GraphFact[], mutate: () => Promise<void>): Promise<void> {
    const head = await context.sql.query<{ sequence: string }>(
      'select (head_sequence+1)::text as sequence from run_graph_heads where run_id=$1', [context.run.id])
    await context.publication.source({ evidence: { sourceKind: kind, sourceId: id, sourceRevision: head.rows[0]!.sequence },
      sourceDigest: graphSourceDigest(value), facts }, mutate)
  }

  /** Application-declared abnormal disposition, not fabricated provider success.
   * Atomic failure resolution unblocks every dependent barrier; native closure
   * remains a separately visible cleanup obligation. */
  async failExecution(executionId: string, code: string, canceled = false): Promise<void> {
    await this.transaction(async (context) => {
      const row = context.executions.get(executionId)
      if (!row || context.resolutions.has(row.execution.workflowNodeId)) return
      if (row.accepted) return conflict('EXECUTION_ACCEPTED_RESULT_CONFLICT', 'Accepted predecessor work must not be rewritten.')
      const execution = row.execution.state === 'completed' ? row.execution : HarnessExecutionSchema.parse({
        ...row.execution, state: 'completed', finishedAt: new Date().toISOString(),
        result: canceled ? { outcome: 'canceled' } : { outcome: 'failed', error: {
          code, message: 'Execution ended without confirmed successful completion. Native work was not replayed.', retryable: false } },
      })
      // A terminal success observed before Stop is preserved, but cannot route after Stop.
      if (execution.result?.outcome === 'succeeded') return
      const resolution = oneShotResolution(context.version, execution)
      const state = await readOneShotRunState(context.sql, context.run.id, context.run, context.stopped)
      state.cleanupPending = true
      const ids = [execution.workflowNodeId]
      const before = await readPublicNodeProjection(context.sql, context.scope, ids)
      const after = await readPublicNodeProjection(context.sql, context.scope, ids, { executions: [execution] })
      const facts: GraphFact[] = [...publicNodeProjectionDelta(before, after),
        { type: 'node.resolved', resolution }, { type: 'run.state', state },
      ]
      const mutate = async () => {
        await context.sql.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(execution)])
        await putNodeResolution(context.sql, context.scope, resolution)
        await context.sql.query(`insert into run_cleanup_intents(run_id) values($1)
          on conflict(run_id) do update set pending=true,updated_at=now()`, [context.run.id])
      }
      if (!context.stopped && !['completed', 'interrupted'].includes(context.run.executionState)) {
        await this.effect(context, 'route.resolve', execution.workflowNodeId, resolution, facts, mutate)
      } else {
        // G1 forbids new routing effects after Stop. Closing an already admitted
        // negative execution is fenced settlement bookkeeping, never activation.
        await this.source(context, 'execution', executionId, { execution, resolution }, facts, mutate)
      }
    })
  }

  async updateRun(update: RunStateUpdate): Promise<void> {
    await this.transaction(async (context) => {
      if (context.run.executionState === 'completed') {
        if (canonicalGraphJson({ ...context.run, ...update }) !== canonicalGraphJson(context.run)) conflict('GRAPH_TERMINAL_CONFLICT', 'Terminal Run state is immutable.')
        return
      }
      if (context.stopped && !['completed', 'interrupted'].includes(update.executionState)) conflict('GRAPH_STOP_CONFLICT', 'The Run is stopping.')
      if (context.stopped && update.outcome === 'succeeded') conflict('GRAPH_STOP_CONFLICT', 'Stop won before completion.')
      if (context.run.executionState === 'interrupted' && !['interrupted', 'completed'].includes(update.executionState)) conflict('GRAPH_TERMINAL_CONFLICT', 'Interrupted work cannot be automatically replayed.')
      const next = WorkflowRunV2Schema.parse({ ...context.run, ...update,
        ...(context.run.startedAt ? { startedAt: context.run.startedAt } : {}) })
      if (canonicalGraphJson(next) === canonicalGraphJson(context.run)) return
      if (update.outcome === 'succeeded') this.terminalResults(context)
      const state = await readOneShotRunState(context.sql, context.run.id, next, context.stopped)
      const closedFacts = ['completed', 'interrupted'].includes(next.executionState)
        ? await publicRunClosedFacts(context.sql, context.scope) : []
      await this.source(context, 'run', context.run.id, next, [{ type: 'run.state', state }, ...closedFacts], async () => {
        await context.sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [next.id, next.executionState, JSON.stringify(next)])
      })
    })
  }

  private terminalResults(context: Context): Array<{ nodeId: string; executionId: string; result: unknown }> {
    const topology = compileOneShotTopology(context.version)
    if (topology.order.some((id) => !context.resolutions.has(id)
      || ['failed', 'canceled'].includes(context.resolutions.get(id)!.resolution))) {
      return conflict('WORKFLOW_UNRESOLVED', 'Every selected path must finish successfully before Run completion.')
    }
    const results = selectedTerminalResolutions([...context.resolutions.values()]).map((resolution) => {
      const row = context.executions.get(resolution.execution!.executionId)
      if (!row?.accepted || row.execution.result?.outcome !== 'succeeded'
        || graphSourceDigest(row.execution.result) !== resolution.acceptedResultDigest) {
        return conflict('EXECUTION_INPUT_NOT_ACCEPTED', 'Terminal paths require exact accepted results.')
      }
      return { nodeId: resolution.workflowNodeId, executionId: row.execution.id, result: row.execution.result.output ?? null }
    })
    if (!results.length) conflict('WORKFLOW_UNRESOLVED', 'A successful Run needs an actual selected terminal path.')
    return results
  }

  async completeRun(): Promise<void> {
    // Result aggregation is rechecked while the same Run lock that arbitrates
    // Stop is held, not just in the earlier graph/checkpoint snapshot.
    await this.transaction(async (context) => {
      if (context.run.executionState === 'completed') {
        if (context.run.outcome !== 'succeeded') conflict('GRAPH_TERMINAL_CONFLICT', 'A failed or canceled Run cannot complete successfully.')
        return
      }
      this.assertActive(context)
      const outputs = this.terminalResults(context)
      const result: ExecutionResult = { outcome: 'succeeded', output: outputs.length === 1 ? outputs[0]!.result as ExecutionResult['output'] : { outputs } as ExecutionResult['output'] }
      const next = WorkflowRunV2Schema.parse({ ...context.run, executionState: 'completed', outcome: 'succeeded', result, finishedAt: new Date().toISOString() })
      try { canonicalGraphJson(next, RUN_GRAPH_LIMITS.transactionBytes) } catch {
        conflict('WORKFLOW_RESULT_TOO_LARGE', 'The selected terminal results exceed the bounded Run result limit.')
      }
      const state = await readOneShotRunState(context.sql, next.id, next, false)
      state.cleanupPending = true
      const closedFacts = await publicRunClosedFacts(context.sql, context.scope)
      await this.source(context, 'run', next.id, next, [{ type: 'run.state', state }, ...closedFacts], async () => {
        await context.sql.query(`insert into run_cleanup_intents(run_id) values($1)
          on conflict(run_id) do update set pending=true,updated_at=now()`, [next.id])
        await context.sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [next.id, next.executionState, JSON.stringify(next)])
      })
    })
  }

  async settleRun(canceled: boolean, interrupted = false): Promise<void> {
    const rows = await this.transaction(async (context) => context.run.executionState === 'completed' ? null : [...context.executions.keys()])
    if (!rows) return
    for (const id of rows) await this.failExecution(id, 'EXECUTION_INTERRUPTED', canceled)
    const latest = await this.transaction(async (context) => ({ stopped: context.stopped, terminal: context.run.executionState === 'completed' }))
    if (latest.terminal) return
    const stopped = latest.stopped
    if (interrupted && !stopped) await this.updateRun({ executionState: 'interrupted', outcome: 'pending' })
    else {
      const result: ExecutionResult = canceled || stopped ? { outcome: 'canceled' } : { outcome: 'failed', error: {
        code: 'WORKFLOW_SELECTED_EXECUTION_FAILED', message: 'A selected execution did not complete successfully.', retryable: false } }
      await this.updateRun({ executionState: 'completed', outcome: result.outcome, result, finishedAt: new Date().toISOString() })
    }
  }

}


/** Bounded current domain aggregates; no Activity/native-history reconstruction. */
export async function readOneShotRunState(sql: GraphTransactionSql, runId: string,
  run: OneShotRun, stopped: boolean): Promise<Extract<GraphFact, { type: 'run.state' }>['state']> {
  const counts = publicAttentionTotals(await readPublicAttentionCounts(sql, runId))
  const row = (await sql.query<{ cleanup: boolean }>(
    'select exists(select 1 from run_cleanup_intents where run_id=$1 and pending) as cleanup', [runId])).rows[0]!
  return { executionState: run.executionState, outcome: run.outcome, stopRequested: stopped,
    ...counts, cleanupPending: row.cleanup || counts.cleanupPending }
}
