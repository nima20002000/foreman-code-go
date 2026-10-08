import type pg from 'pg'
import { z } from 'zod'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { subagentCapabilities, RunSubagentSchema, RunSubagentGetInputSchema, RunSubagentsListInputSchema, RunSubagentItemsInputSchema,
  RunSubagentMessagesPageSchema, RunSubagentToolsPageSchema, RunSubagentDetailSchema, RunSubagentsPageSchema } from '@foreman-code/contracts/subagents'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { subagentAvailableActions } from './capabilities.js'
import { reconcileRunSubagents } from './projection.js'
import { backfillRunSubagents } from './recovery.js'
import type { SubagentNativeRecoverySource, SubagentControlResolver } from './types.js'
import { executeSubagentCommand } from './commands.js'
import { componentLogger } from '../diagnostics/logger.js'

export interface SubagentRecoveryFailure {
  workspaceId: string; runId: string; executionId?: string; code: string
}
const recoveryLogger = componentLogger('harness')

function readSubagent(record: unknown) {
  const child = RunSubagentSchema.parse(record)
  if (child.provider !== 'codex') return child
  const controls = subagentCapabilities(child.nativeMode)
  return { ...child, capabilities: { ...child.capabilities,
    sendInput: controls.sendInput, interrupt: controls.interrupt,
    executionResume: controls.executionResume, inputTiming: controls.inputTiming,
  } }
}

export interface SubagentReadScope { sql: pg.PoolClient; principal: ManagementPrincipal; stopped: boolean; workflowId: string; workflowVersionId: string }
export class RunSubagentService {
  private readonly backfills = new Map<string, Promise<void>>()
  constructor(readonly pool: pg.Pool, readonly controls: SubagentControlResolver = () => undefined, readonly nativeRecovery?: SubagentNativeRecoverySource,
    private readonly onRecoveryFailure: (failure: SubagentRecoveryFailure) => void = failure => recoveryLogger.error(failure, 'Run subagent recovery failed')) {}
  reportRecoveryFailure(failure: SubagentRecoveryFailure) {
    // Diagnostics must not turn detached recovery into an unhandled rejection.
    // Log identifiers/codes only; native errors may contain prompts or secrets.
    try { this.onRecoveryFailure(failure) }
    catch { recoveryLogger.error({ ...failure, code: 'SUBAGENT_RECOVERY_REPORT_FAILED' }, 'Run subagent recovery diagnostic failed') }
  }
  scheduleRecovery(principal: ManagementPrincipal, input: { workspaceId: string; runId: string }) {
    if (!this.nativeRecovery || this.backfills.has(input.runId)) return
    const task = backfillRunSubagents(this, principal, input)
      .catch(() => { this.reportRecoveryFailure({ ...input, code: 'SUBAGENT_RECOVERY_FAILED' }) })
      .finally(() => { this.backfills.delete(input.runId) })
    this.backfills.set(input.runId, task)
  }
  async close() { await Promise.allSettled(this.backfills.values()) }

  private readChild(record: unknown) {
    const child = readSubagent(record)
    if (child.provider !== 'codex') return child
    const lease = this.controls(child)
    if (!lease?.capabilities || !lease.matches(child)) return child
    return RunSubagentSchema.parse({ ...child, capabilities: { ...child.capabilities, ...lease.capabilities } })
  }

  /** Exact live grants and immutable Run ownership are rechecked for every page, command and retry. */
  async scoped<T>(principal: ManagementPrincipal, input: { workspaceId: string; runId: string }, action: ManagementAction,
    work: (scope: SubagentReadScope) => Promise<T>): Promise<T> {
    const sql = await this.pool.connect()
    try {
      await sql.query('begin')
      const row = (await sql.query<{ workflow_id: string; workflow_version_id: string; stopped: boolean }>(`select workflow_id,workflow_version_id,
        (stop_requested_at is not null or execution_state in ('completed','interrupted')) as stopped from runs where id=$1 and workspace_id=$2 for share`, [input.runId, input.workspaceId])).rows[0]
      if (!row) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workspace.', 404)
      const live = await readLiveManagementPrincipal(sql, principal.id)
      const resource = { workspaceId: input.workspaceId, workflowId: row.workflow_id, runId: input.runId }
      requireAuthorization(live, 'runs:read', resource)
      requireAuthorization(live, action, resource)
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`run-subagents:${input.runId}`])
      const result = await work({ sql, principal: live, stopped: row.stopped, workflowId: row.workflow_id, workflowVersionId: row.workflow_version_id })
      await sql.query('commit')
      return result
    } catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
  }
  async child(scope: SubagentReadScope, input: z.infer<typeof RunSubagentGetInputSchema>) {
    const row = (await scope.sql.query<{ record: unknown }>('select record from run_subagents where id=$1 and run_id=$2 for update', [input.subagentId, input.runId])).rows[0]
    if (!row) throw new DomainError('SUBAGENT_NOT_FOUND', 'The child was not found in this Run.', 404)
    const child = this.readChild(row.record)
    if (child.workspaceId !== input.workspaceId || child.workflowId !== scope.workflowId || child.workflowVersionId !== scope.workflowVersionId) {
      throw new DomainError('SUBAGENT_SCOPE_CONFLICT', 'The child no longer matches the immutable Run scope.', 409)
    }
    return child
  }
  async list(principal: ManagementPrincipal, raw: unknown) {
    const input = RunSubagentsListInputSchema.parse(raw)
    const result = await this.scoped(principal, input, 'runs:read', async scope => {
      const projection = await reconcileRunSubagents(scope.sql, input.runId)
      const key = decodeCursor(input.cursor, [input.workspaceId, input.runId, 'children'])
      const rows = (await scope.sql.query<{ id: string; record: unknown }>(`select id,record from run_subagents where run_id=$1 and ($2::text is null or id>$2 collate "C") order by id collate "C" limit $3`, [input.runId, key, input.limit + 1])).rows
      return RunSubagentsPageSchema.parse({ items: await Promise.all(rows.slice(0, input.limit).map(async row => {
        const child = this.readChild(row.record)
        if (child.workspaceId !== input.workspaceId || child.workflowId !== scope.workflowId || child.workflowVersionId !== scope.workflowVersionId) throw new DomainError('SUBAGENT_SCOPE_CONFLICT', 'The child has inconsistent immutable Run scope.', 409)
        return { subagent: child, availableActions: subagentAvailableActions(child, scope.principal, scope.stopped, this.controls(child)) }
      })), nextCursor: rows.length > input.limit ? encodeCursor([input.workspaceId, input.runId, 'children'], rows[input.limit - 1]!.id) : null, projection })
    })
    this.scheduleRecovery(principal, input)
    return result
  }
  async get(principal: ManagementPrincipal, raw: unknown) {
    const input = RunSubagentGetInputSchema.parse(raw)
    return this.scoped(principal, input, 'runs:read', async scope => {
      await reconcileRunSubagents(scope.sql, input.runId)
      const child = await this.child(scope, input)
      const lease = this.controls(child)
      const pendingInteraction = lease?.pendingInteraction?.()
      return RunSubagentDetailSchema.parse({ subagent: child,
        availableActions: subagentAvailableActions(child, scope.principal, scope.stopped, lease),
        ...(pendingInteraction ? { pendingInteraction } : {}) })
    })
  }
  items(principal: ManagementPrincipal, raw: unknown, kind: 'message'): Promise<z.infer<typeof RunSubagentMessagesPageSchema>>
  items(principal: ManagementPrincipal, raw: unknown, kind: 'tool'): Promise<z.infer<typeof RunSubagentToolsPageSchema>>
  async items(principal: ManagementPrincipal, raw: unknown, kind: 'message' | 'tool') {
    const input = RunSubagentItemsInputSchema.parse(raw)
    return this.scoped(principal, input, 'runs:read', async scope => {
      await reconcileRunSubagents(scope.sql, input.runId)
      const child = await this.child(scope, input)
      const namespace = [input.workspaceId, input.runId, input.subagentId, kind]
      const key = decodeCursor(input.cursor, namespace)
      if (key !== null && !/^[1-9][0-9]*$/.test(key)) throw new DomainError('SUBAGENT_CURSOR_INVALID', 'The page cursor is invalid.', 400)
      const rows = (await scope.sql.query<{ ordinal: string; record: unknown }>(`select ordinal::text,record from run_subagent_items where subagent_id=$1 and kind=$2
        and ($3::bigint is null or ordinal>$3::bigint) order by ordinal limit $4`, [child.id, kind, key, input.limit + 1])).rows
      return (kind === 'message' ? RunSubagentMessagesPageSchema : RunSubagentToolsPageSchema).parse({ items: rows.slice(0, input.limit).map(row => row.record),
        nextCursor: rows.length > input.limit ? encodeCursor(namespace, rows[input.limit - 1]!.ordinal) : null, coverage: child.coverage })
    })
  }
  messages(principal: ManagementPrincipal, input: unknown) { return this.items(principal, input, 'message') }
  tools(principal: ManagementPrincipal, input: unknown) { return this.items(principal, input, 'tool') }
  input(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) { return executeSubagentCommand(this, principal, source, 'run_subagent_input_v1', raw) }
  interrupt(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) { return executeSubagentCommand(this, principal, source, 'run_subagent_interrupt_v1', raw) }
  respond(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    return executeSubagentCommand(this, principal, source, 'run_subagent_respond_v1', raw)
  }
}
function encodeCursor(scope: string[], key: string) { return Buffer.from(JSON.stringify({ scope, key })).toString('base64url') }
function decodeCursor(cursor: string | undefined, scope: string[]): string | null {
  if (!cursor) return null
  try {
    const parsed = z.object({ scope: z.array(z.string()), key: z.string().min(1).max(512) }).strict().parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
    if (JSON.stringify(parsed.scope) === JSON.stringify(scope)) return parsed.key
  } catch { /* All malformed and cross-scope cursors share the same public error. */ }
  throw new DomainError('SUBAGENT_CURSOR_INVALID', 'The page cursor does not belong to this exact child read.', 400)
}
