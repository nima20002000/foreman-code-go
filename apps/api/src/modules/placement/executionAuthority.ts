import type pg from 'pg'
import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { ExecutionFactsRequestSchema, ExecutionFactsResultSchema, ExecutionAuthorityRequestSchema, ExecutionAuthorityResultSchema, EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { readPlacement } from './binding.js'
import { readExecutionPlacement, readNativePlacement } from './persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { withExclusiveGraphConnection, beforeGraphCommit } from '../run-graph/connection.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
export interface ExecutionRunAuthorityPort {
  revalidateRunAuthorization(principalId: string, workspaceId: string, workflowId: string, client: GraphSqlClient, atCommit: boolean): Promise<void>
}
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { DomainError } from '../errors.js'
import { assertRemoteReviewAssignment, remoteReviewerPolicy } from './remoteReviewerAuthority.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'

const denied = (): never => { throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Exact original execution authority is unavailable or revoked.', 403) }
/** Read-only admission fence. This NEVER issues an entry capability, command,
 * new grant, allocation or lease; main and worker entry guards remain mandatory. */
export async function assertRemoteExecutionAuthority(sql: GraphSqlClient,
  locations: ExecutionRunAuthorityPort,
  raw: unknown, authenticated: Readonly<DeviceConnectionIdentity>, producer: AgentPlacementProducer): Promise<{ cleanupOnly: true } | undefined> {
  const input = ExecutionAuthorityRequestSchema.parse(raw), pin = readPlacement(input.placement)
  const current = await readReconciledDispatchIntent(sql, input.intent.operationId, true)
  const persisted = await readExecutionPlacement(sql, input.intent.executionId)
  if (!current || !persisted || !sameWorkflowValue(current, input.intent) || !sameWorkflowValue(pin, persisted)
    || pin.hostRef.kind !== 'device' || !pin.registration || authenticated.mainId !== pin.mainId
    || authenticated.deviceId !== pin.hostRef.deviceId || authenticated.workerInstallationId !== pin.registration.workerInstallationId
    || authenticated.keyRevision !== pin.registration.keyRevision || authenticated.authorizationRevision !== pin.registration.authorizationRevision) denied()
  const registration = await assertDeviceHostInstallation(sql, pin.hostRef, pin.registration!.workerInstallationId)
  if (!registration || registration.keyRevision !== pin.registration!.keyRevision
    || registration.authorizationRevision !== pin.registration!.authorizationRevision) denied()
  const row = (await sql.query<{ authorization_principal_id: string; workspace_id: string; workflow_id: string;
    execution_state: string; stopped: boolean; cleanup: boolean }>(`select r.record->>'authorizationPrincipalId' as authorization_principal_id,
      r.workspace_id,r.workflow_id,r.execution_state,r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents i where i.run_id=r.id and i.pending) as cleanup
      from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2 for share of r,e`,
    [current!.runId, current!.executionId])).rows[0]
  if (!row) denied()
  if (input.action === 'stop' && !row!.cleanup) denied()
  const cleanup = row!.cleanup && (input.action === 'stop' || input.action === 'read')
  const grant = await sql.query(`select 1 from execution_dispatch_owner_grants
    where execution_id=$1 and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked for share`,
    [current!.executionId, current!.operationId, current!.owner.grantId, current!.owner.epoch])
  if (grant.rowCount !== 1) denied()
  const origin = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share', [current!.operationId])).rows[0]
  if (!origin) denied()
  const connection = DeviceConnectionIdentitySchema.parse(origin!.connection)
  if (connection.mainId !== authenticated.mainId || connection.deviceId !== authenticated.deviceId
    || connection.workerInstallationId !== authenticated.workerInstallationId || connection.keyRevision !== authenticated.keyRevision
    || connection.authorizationRevision !== authenticated.authorizationRevision) denied()
  if (input.action !== 'read' && input.action !== 'stop' && connection.bootId !== authenticated.bootId) denied()
  const changedBoot = connection.bootId !== authenticated.bootId
  const reconnected = !changedBoot
    && connection.connectionGeneration !== authenticated.connectionGeneration
  let resident: boolean
  {
    const stored = (await sql.query<{ receipt: unknown }>(
      'select receipt from remote_execution_receipts where operation_id=$1 for share', [current!.operationId])).rows[0]
    const receipt = RemoteOperationReceiptSchema.safeParse(stored?.receipt)
    if (stored && (!receipt.success || !sameWorkflowValue(receipt.data.intent, current)
      || !sameWorkflowValue(receipt.data.connection, connection))) denied()
    resident = receipt.success && receipt.data.native !== undefined
    if ((reconnected || changedBoot)
      && (input.action === 'start' || !['read', 'stop'].includes(input.action) && !resident)) denied()
  }
  // Cleanup observes and cancels the admitted owner even when it can no longer launch.
  if (!cleanup) {
    await locations.revalidateRunAuthorization(row!.authorization_principal_id, row!.workspace_id, row!.workflow_id,
      sql, true)
    // A restarted OS can read the admitted owner's closure; it cannot qualify that process to continue.
    if (!changedBoot && (!reconnected || resident)) {
      await producer.assertPinsCurrent(sql, pin, await readLiveManagementPrincipal(sql, row!.authorization_principal_id),
        row!.workspace_id, resident ? { purpose: 'resident' } : undefined)
    }
  }
  if (input.action === 'start') {
    if (!await readNativePlacement(sql, current!.executionId)) denied()
    if (row!.stopped || !['running', 'waiting'].includes(row!.execution_state)) denied()
    const entry = await sql.query("select 1 from workflow_native_entries where execution_id=$1 and run_id=$2 and phase='entered' for share", [current!.executionId, current!.runId])
    if (entry.rowCount !== 1) denied()
  }
  if (input.action === 'retain-reviewer' || input.action === 'review') {
    if (row!.stopped || row!.cleanup || !['running', 'waiting'].includes(row!.execution_state)) denied()
    if (input.action === 'review') {
      if (!input.review) denied()
      await assertRemoteReviewAssignment(sql, input.intent, input.review!)
    }
  }
  return cleanup ? { cleanupOnly: true } : undefined
}
export function createExecutionAuthorityExtension(pool: pg.Pool,
  locations: ExecutionRunAuthorityPort, producer: AgentPlacementProducer): DeviceExtensionRegistration {
  return { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server', async handle(raw, context) {
    if (context.bytes?.byteLength) denied()
    const facts = ExecutionFactsRequestSchema.safeParse(raw)
    const input = facts.success ? facts.data.authorization : ExecutionAuthorityRequestSchema.parse(raw)
    return withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
      const authority = await assertRemoteExecutionAuthority(sql, locations, input, context.binding, producer)
      beforeGraphCommit(sql, async () => { await assertRemoteExecutionAuthority(sql, locations, input, context.binding, producer) })
      if (facts.success) {
        if ((await sql.query('select 1 from source_preparation_reconciliations where operation_id=$1 for share',
          [input.intent.operationId])).rowCount) denied()
        const placement = await readExecutionPlacement(sql, input.intent.executionId)
        const native = await readNativePlacement(sql, input.intent.executionId)
        if (!placement || !native || placement.payload.kind !== 'agent') denied()
        const configuration = (await sql.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1 and agent_id=$2',
          [placement!.payload.kind === 'agent' ? placement!.payload.agentConfigurationVersionId : '', placement!.payload.kind === 'agent' ? placement!.payload.agentId : ''])).rows[0]?.record
        const origin = (await sql.query<{ connection: unknown }>(
          'select connection from remote_dispatch_origins where operation_id=$1 for share',
          [input.intent.operationId])).rows[0]
        const originalConnection = DeviceConnectionIdentitySchema.parse(origin?.connection)
        const stored = (await sql.query<{ receipt: unknown }>(
          'select receipt from remote_execution_receipts where operation_id=$1 for share',
          [input.intent.operationId])).rows[0]
        const receipt = stored && RemoteOperationReceiptSchema.parse(stored.receipt)
        const resident = originalConnection.bootId === context.binding.bootId && receipt?.native !== undefined
        const harness = await producer.harnessFacts(sql, placement!, resident ? { purpose: 'resident' } : undefined)
        return { payload: ExecutionFactsResultSchema.parse({ version: 1, intent: input.intent, placement, executionPlacement: native, configuration, harness }) }
      }
      const policy = input.action === 'retain-reviewer' || input.action === 'review'
        ? await remoteReviewerPolicy(sql, input.intent) : undefined
      return { payload: ExecutionAuthorityResultSchema.parse({ version: 1, action: input.action,
        operationId: input.intent.operationId, attemptId: input.intent.attemptId, bindingHash: input.intent.bindingHash,
        owner: input.intent.owner, ...authority,
        ...(policy ? { reviewer: { agentId: policy.execution.agentId,
          expiresAt: new Date(Date.now() + 60_000).toISOString() } } : {}) }) }
    }))
  } }
}
