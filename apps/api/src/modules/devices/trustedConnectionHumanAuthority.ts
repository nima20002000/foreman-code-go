import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { DeviceRegistrationSchema, type DeviceRegistration } from '@graphql/contracts/device-identity'
import { TrustedConnectionConfigureSchema, TrustedConnectionConsentSchema, TrustedConnectionApprovalRequestSchema,
  TrustedConnectionApprovalCommandSchema, TrustedConnectionApprovalReceiptSchema, TrustedConnectionApprovalReadSchema,
  type TrustedConnectionConfigure, type TrustedConnectionApprovalReceipt, type TrustedConnectionApprovalRead } from '@graphql/contracts/trusted-device-connection'
export { TrustedConnectionApprovalRequestSchema, TrustedConnectionApprovalCommandSchema, TrustedConnectionApprovalReceiptSchema, TrustedConnectionApprovalReadSchema } from '@graphql/contracts/trusted-device-connection'
export type { TrustedConnectionApprovalReceipt, TrustedConnectionApprovalRead } from '@graphql/contracts/trusted-device-connection'
import { z } from 'zod'
import { requireBrowserSession, requirePrincipal } from '../access/http.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator, commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

const REQUEST = 'device.trusted-connection.approval.request'
const APPROVE = 'device.trusted-connection.approval.approve'
const REVOKE = 'device.trusted-connection.approval.revoke'
const CONSUME = 'device.trusted-connection.approval.consume'
const EventSchema = z.object({ id: z.uuid(), ownerId: z.string(), actionHash: z.string(), at: z.string().datetime() }).strict()
const ConsumedSchema = EventSchema.extend({ configureCommandId: z.string().min(8) }).strict()
const reject = (code: string, message: string, status = 403): never => { throw new DomainError(code, message, status) }

/** Connection-specific human authority. Only verified browser routes issue approval.
 * Uses immutable original command receipts; no generic approval IDs or Job authority. */
export class PostgresTrustedConnectionHumanAuthority {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string) {}
  private target(id: string) { return `${this.mainId}:${id}` }
  private async owner(client: pg.PoolClient, principal: ManagementPrincipal, write: boolean): Promise<string> {
    requireAuthorization(principal, write ? 'settings:update' : 'settings:read')
    requireAuthorization(await readLiveManagementPrincipal(client, principal.id), write ? 'settings:update' : 'settings:read')
    const row = (await client.query<{ principal_id: string }>('select principal_id from browser_auth_owner where singleton=true for share')).rows[0]
    if (!row || row.principal_id !== principal.id) reject('DEVICE_CONNECTION_WRONG_OWNER', 'Only the current signed-in application owner can authorize this action.')
    return row!.principal_id
  }
  private browser(request: FastifyRequest): ManagementPrincipal {
    requireBrowserSession(request)
    return requirePrincipal(request)
  }
  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('begin'); const result = await operation(client); await client.query('commit'); return result }
    catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  private async lock(client: pg.PoolClient, id: string): Promise<void> {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`trusted-connection-approval:${this.target(id)}`])
  }
  private async receipt(client: pg.PoolClient, id: string): Promise<TrustedConnectionApprovalReceipt> {
    const row = (await client.query<{ result: unknown }>(`select result from management_command_receipts
      where operation=$1 and result->>'id'=$2 and result->>'mainId'=$3 for share`, [REQUEST, id, this.mainId])).rows[0]
    if (!row) reject('DEVICE_CONNECTION_APPROVAL_NOT_FOUND', 'This connection approval request does not exist.', 404)
    return TrustedConnectionApprovalReceiptSchema.parse(row!.result)
  }
  private async current(client: pg.PoolClient, action: TrustedConnectionConfigure): Promise<{ registration: DeviceRegistration; revision: number }> {
    const row = (await client.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [action.deviceId, this.mainId])).rows[0]
    if (!row) reject('DEVICE_NOT_FOUND', 'The device is not registered on this Main.', 404)
    const registration = DeviceRegistrationSchema.parse(row!.record)
    const consent = (await client.query<{ result: unknown }>(`select result from management_command_receipts where operation=$1 and target_key=$2
      order by (result->>'revision')::bigint desc limit 1`, ['device.trusted-connection.configure', this.target(action.deviceId)])).rows[0]
    return { registration, revision: consent ? TrustedConnectionConsentSchema.parse(consent.result).revision : 0 }
  }
  private async state(client: pg.PoolClient, receipt: TrustedConnectionApprovalReceipt): Promise<TrustedConnectionApprovalRead> {
    const rows = (await client.query<{ operation: string; result: unknown }>(`select operation,result from management_command_receipts where target_key=$1 and operation=any($2::text[]) for share`, [this.target(receipt.id), [APPROVE, REVOKE, CONSUME]])).rows
    const approved = rows.filter(row => row.operation === APPROVE).map(row => EventSchema.parse(row.result))[0]
    const revoked = rows.filter(row => row.operation === REVOKE).map(row => EventSchema.parse(row.result))[0]
    const consumed = rows.filter(row => row.operation === CONSUME).map(row => ConsumedSchema.parse(row.result))[0]
    const current = await this.current(client, receipt.action)
    const state: TrustedConnectionApprovalRead['state'] = revoked || current.registration.status === 'revoked' ? 'revoked'
      : consumed ? 'consumed' : Date.parse(receipt.expiresAt) <= Date.now() ? 'expired'
      : current.registration.status !== 'paired' || commandInputHash(current.registration) !== commandInputHash(receipt.registration)
        || current.revision !== receipt.action.expectedRevision ? 'stale' : approved ? 'approved' : 'pending'
    return TrustedConnectionApprovalReadSchema.parse({ ...receipt, state, approvedAt: approved?.at ?? null, consumedAt: consumed?.at ?? null, revokedAt: revoked?.at ?? null })
  }
  async requestBrowser(request: FastifyRequest, raw: z.infer<typeof TrustedConnectionApprovalRequestSchema>): Promise<TrustedConnectionApprovalRead> {
    const principal = this.browser(request), input = TrustedConnectionApprovalRequestSchema.parse(raw)
    const result = await new PostgresCommandCoordinator(this.pool).execute({ principal, source: 'http', operation: REQUEST,
      commandId: input.requestCommandId, targetKey: this.target(input.action.deviceId), payload: input,
      authorize: async client => { await this.owner(client, principal, true) },
      perform: async client => {
        const ownerId = await this.owner(client, principal, true), id = randomUUID()
        const action = TrustedConnectionConfigureSchema.parse({ ...input.action, approvalId: id })
        const current = await this.current(client, action)
        if (current.registration.status !== 'paired' || current.registration.authorizationRevision !== action.expectedAuthorizationRevision || current.revision !== action.expectedRevision) {
          reject('DEVICE_CONNECTION_APPROVAL_STALE', 'The paired device or consent changed. Review current facts before requesting approval.', 409)
        }
        return TrustedConnectionApprovalReceiptSchema.parse({ id, mainId: this.mainId, ownerId, action, registration: current.registration,
          requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() })
      } })
    // Retry returns original identity/expiry, with current status rather than a stale pending claim.
    return this.readBrowser(request, TrustedConnectionApprovalReceiptSchema.parse(result.value).id)
  }
  async readBrowser(request: FastifyRequest, rawId: string): Promise<TrustedConnectionApprovalRead> {
    const principal = this.browser(request), id = z.uuid().parse(rawId)
    return this.transaction(async client => {
      const ownerId = await this.owner(client, principal, false)
      await this.lock(client, id)
      const receipt = await this.receipt(client, id)
      if (receipt.ownerId !== ownerId) reject('DEVICE_CONNECTION_WRONG_OWNER', 'This approval belongs to a different owner.')
      return this.state(client, receipt)
    })
  }
  async decideBrowser(request: FastifyRequest, rawId: string, raw: z.infer<typeof TrustedConnectionApprovalCommandSchema>, decision: 'approve' | 'revoke'): Promise<TrustedConnectionApprovalRead> {
    const principal = this.browser(request), id = z.uuid().parse(rawId), input = TrustedConnectionApprovalCommandSchema.parse(raw)
    await new PostgresCommandCoordinator(this.pool).execute({ principal, source: 'http', operation: decision === 'approve' ? APPROVE : REVOKE,
      commandId: input.commandId, targetKey: this.target(id), payload: { id, decision },
      authorize: async client => { await this.owner(client, principal, true); await this.lock(client, id) },
      perform: async client => {
        const ownerId = await this.owner(client, principal, true), receipt = await this.receipt(client, id)
        if (receipt.ownerId !== ownerId) reject('DEVICE_CONNECTION_WRONG_OWNER', 'This approval belongs to a different owner.')
        const status = await this.state(client, receipt)
        if (decision === 'approve' && status.state !== 'pending' || decision === 'revoke' && ['consumed', 'revoked'].includes(status.state)) {
          reject('DEVICE_CONNECTION_APPROVAL_NOT_PENDING', 'This request can no longer accept that decision.', 409)
        }
        return EventSchema.parse({ id, ownerId, actionHash: commandInputHash(receipt), at: new Date().toISOString() })
      } })
    return this.readBrowser(request, id)
  }
  /** Adapter runs in the configure transaction; receipt consumption rolls back if
   * configuration fails and is committed atomically with its consent/audit. */
  readonly verifyOwnerApproval = async (client: pg.PoolClient, principal: ManagementPrincipal, input: TrustedConnectionConfigure, registration: DeviceRegistration): Promise<{ ownerId: string }> => {
    const ownerId = await this.owner(client, principal, true)
    await this.lock(client, input.approvalId)
    const receipt = await this.receipt(client, input.approvalId)
    if (receipt.ownerId !== ownerId) reject('DEVICE_CONNECTION_WRONG_OWNER', 'This approval belongs to a different owner.')
    if (commandInputHash(receipt.action) !== commandInputHash(input) || commandInputHash(receipt.registration) !== commandInputHash(registration)) {
      reject('DEVICE_CONNECTION_APPROVAL_MISMATCH', 'The approved action or paired identity does not match this command.')
    }
    const status = await this.state(client, receipt)
    if (status.state !== 'approved') reject('DEVICE_CONNECTION_OWNER_APPROVAL_REQUIRED', `The exact human approval is ${status.state}.`)
    const approval = (await client.query<{ result: unknown }>(`select result from management_command_receipts where operation=$1 and target_key=$2 for share`, [APPROVE, this.target(input.approvalId)])).rows[0]
    const event = EventSchema.parse(approval?.result)
    if (event.ownerId !== ownerId || event.actionHash !== commandInputHash(receipt)) reject('DEVICE_CONNECTION_APPROVAL_MISMATCH', 'The original human decision receipt does not match this action.')
    const consumption = ConsumedSchema.parse({ id: input.approvalId, ownerId, actionHash: commandInputHash(receipt), at: new Date().toISOString(), configureCommandId: input.commandId })
    await client.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result) values($1,$2,$3,$4,$5,$6::jsonb)`,
      [principal.id, CONSUME, input.commandId, this.target(input.approvalId), commandInputHash(input), JSON.stringify(consumption)])
    return { ownerId }
  }
}
export function registerTrustedConnectionApprovalRoutes(app: FastifyInstance, authority: PostgresTrustedConnectionHumanAuthority): void {
  const root = '/api/devices/connection-approvals'
  app.post(root, request => authority.requestBrowser(request, TrustedConnectionApprovalRequestSchema.parse(request.body)))
  app.get<{ Params: { approvalId: string } }>(`${root}/:approvalId`, request => authority.readBrowser(request, request.params.approvalId))
  app.post<{ Params: { approvalId: string } }>(`${root}/:approvalId/approve`, request => authority.decideBrowser(request, request.params.approvalId, TrustedConnectionApprovalCommandSchema.parse(request.body), 'approve'))
  app.post<{ Params: { approvalId: string } }>(`${root}/:approvalId/revoke`, request => authority.decideBrowser(request, request.params.approvalId, TrustedConnectionApprovalCommandSchema.parse(request.body), 'revoke'))
}
