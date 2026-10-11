import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  ProviderAccountApiKeyInputSchema, ProviderAccountCommandInputSchema,
  ProviderAccountCreateInputSchema, ProviderAccountIdSchema, ProviderAccountRenameInputSchema,
  type AccountProvider, type ProviderAccount, type ProviderAccountAuthMode,
  ProviderAccountsSnapshotSchema, type ProviderAccountsSnapshot,
  type AcceptedProviderAccountBinding, type ProviderAccountBinding, type ProviderAccountAuthenticationOperation,
  type ProviderAccountNativeAuthenticationObservation, type ProviderAccountObservation, type ProviderAccountModels,
} from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization, requireLiveAccountAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { LocalProviderCredentials } from './localCredentials.js'
import type { ProviderAccountNativePort } from './nativeCommands.js'
import { ProviderAccountsRepository } from './repository.js'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ProviderAccountNativeInput } from './nativeCommands.js'
import { sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { isDeepStrictEqual } from 'node:util'
import { ProviderAccountListInputSchema, ProviderAccountPageSchema, ProviderAccountGetInputSchema,
  ProviderAccountRegisterInputSchema, ProviderAccountDefaultInputSchema, ProviderAccountBindingSchema,
  ProviderAccountObservationSchema, ProviderAccountModelsSchema,
  ProviderAccountAuthenticationReadInputSchema, ProviderAccountAuthenticationPrepareInputSchema,
  ProviderAccountAuthenticationCancelInputSchema } from '@foreman-code/contracts/provider-accounts'
import { assertAccountUnused, ProviderAccountAuthenticationOperations } from './authenticationOperations.js'
import { AcceptedProviderAccountBindings } from './acceptedBindings.js'
import { legacyProviderAccountBinding, readProviderAccountBinding, type AccountBindingOwner } from './acceptedBindings.js'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'

export interface ResolvedProviderAccount {
  accountId: string
  homePath: string
  authMode: ProviderAccountAuthMode
  apiKey?: string
  binding?: ProviderAccountBinding
  observation?: ProviderAccountObservation
}
export interface ProviderAccountResolver {
  resolve(provider: AccountProvider, accountId?: string,
    options?: { sql?: GraphSqlClient; allowDefault?: boolean;
      acceptedBinding?: AcceptedProviderAccountBinding }): Promise<ResolvedProviderAccount | null>
}
/** Native paths stay inside the owning host; only sanitized observations cross this port. */
export interface ProviderAccountOperationNativePort extends ProviderAccountNativePort {
  prepareAuthentication?(input: ProviderAccountNativeInput & {
    operation: ProviderAccountAuthenticationOperation;
  }): Promise<ProviderAccountNativeAuthenticationObservation>
  observeAuthentication?(input: ProviderAccountNativeInput & {
    operation: ProviderAccountAuthenticationOperation;
  }): Promise<ProviderAccountNativeAuthenticationObservation>
  cancelAuthentication?(input: ProviderAccountNativeInput & {
    operation: ProviderAccountAuthenticationOperation;
  }): Promise<ProviderAccountNativeAuthenticationObservation>
  registerProfile?(input: { provider: AccountProvider; profileRef: string; qualificationId: string;
    target: DeviceProvisioningTarget }): Promise<{ profileRef: string }>
  observeAccount?(input: ProviderAccountNativeInput): Promise<ProviderAccountObservation>
  models?(input: ProviderAccountNativeInput): Promise<ProviderAccountModels>
  authenticationGeneration?(input: ProviderAccountNativeInput): Promise<number>
  requireRuntimeAccount?(input: ProviderAccountNativeInput): Promise<void>
  resolveProfile?(account: ProviderAccount): Promise<{ homePath: string; userHome: string }>
}
type CommandSource = 'http' | 'mcp'
type Change = (snapshot: ProviderAccountsSnapshot, sql: GraphSqlClient) => Promise<void>

export class ProviderAccountsService implements ProviderAccountResolver {
  readonly acceptedBindings = new AcceptedProviderAccountBindings(this)
  private readonly authentication: ProviderAccountAuthenticationOperations
  constructor(
    private readonly pool: pg.Pool,
    private readonly repository: ProviderAccountsRepository,
    private readonly credentials: LocalProviderCredentials,
    private readonly native: ProviderAccountOperationNativePort,
    private readonly commands: PostgresCommandCoordinator,
  ) {
    this.authentication = new ProviderAccountAuthenticationOperations(pool, repository, credentials, native, commands,
      (sql, principal, manage, accountId) => this.authorize(sql, principal,
        manage ? 'provider_accounts:manage' : 'provider_accounts:read', accountId))
  }

  bindTarget(reader: () => Promise<DeviceProvisioningTarget>): void { this.repository.bindTarget(reader) }

  async runtimeBinding(kind: AccountBindingOwner, id: string, configuration: HarnessConfiguration,
    selection?: HarnessProfileSelection): Promise<AcceptedProviderAccountBinding | undefined> {
    return await readProviderAccountBinding(this.pool, kind, id)
      ?? legacyProviderAccountBinding(configuration, selection)
  }

  async assertAuthenticationEligibility(operation: ProviderAccountAuthenticationOperation): Promise<void> {
    const row = (await this.pool.query<{ principal_id: string }>(
      'select principal_id from provider_account_authentication_operations where id=$1', [operation.id])).rows[0]
    if (!row) throw new DomainError('PROVIDER_AUTHENTICATION_NOT_FOUND', 'The accepted operation is unavailable.', 404)
    const principal = await readLiveManagementPrincipal(this.pool, row.principal_id)
    await this.authorize(this.pool, principal, 'provider_accounts:manage', operation.binding.accountId)
    await assertAccountUnused(this.pool, operation.binding.accountId)
  }

  private async authorize(sql: GraphSqlClient, principal: ManagementPrincipal,
    action: 'provider_accounts:read' | 'provider_accounts:manage' = 'provider_accounts:read',
    accountId?: string): Promise<void> {
    const target = await this.repository.target()
    const resource = { mainId: target.hostRef.mainId,
      applicationInstallationId: target.applicationInstallationId,
      ...(target.hostRef.kind === 'device' ? { deviceId: target.hostRef.deviceId } : {}),
      ...(accountId ? { providerAccountId: accountId } : {}) }
    requireAuthorization(principal, 'provider_accounts:read', resource)
    const current = await readLiveManagementPrincipal(sql, principal.id)
    requireAuthorization(current, 'provider_accounts:read', resource)
    requireAuthorization(current, action, resource)
    await requireLiveAccountAuthorization(sql, principal.id, action, resource)
  }

  private async checkTarget(target?: DeviceProvisioningTarget): Promise<void> {
    if (target && !sameDeviceProvisioningTarget(target, await this.repository.target())) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The account belongs to another computer or installation.', 409)
    }
  }

  private async authorizeMutation(principal: ManagementPrincipal, source: CommandSource, operation: string,
    accountId?: string, target?: DeviceProvisioningTarget): Promise<void> {
    try {
      await this.checkTarget(target)
      await this.authorize(this.pool, principal, 'provider_accounts:manage', accountId)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, operation, await this.repository.key())
      }
      throw error
    }
  }

  async auditDenied(principal: ManagementPrincipal, source: CommandSource, operation: string, accountId: string) {
    await this.commands.recordDenied(principal.id, source, operation, `provider-account:${accountId}`)
  }

  async list(principal: ManagementPrincipal): Promise<ProviderAccountsSnapshot> {
    await this.authorize(this.pool, principal)
    const snapshot = await this.repository.read()
    for (const account of snapshot.accounts) {
      if (!account.removedAt) Object.assign(account, await this.status(account))
    }
    await this.authorize(this.pool, principal)
    return snapshot
  }

  async page(principal: ManagementPrincipal, raw: unknown) {
    const input = ProviderAccountListInputSchema.parse(raw)
    await this.checkTarget(input.target)
    await this.authorize(this.pool, principal)
    const snapshot = await this.repository.read()
    const accounts = snapshot.accounts.filter(account => (input.includeRemoved || !account.removedAt)
      && (!input.provider || account.provider === input.provider)).sort((a, b) => a.id.localeCompare(b.id))
    const filtered = input.cursor ? accounts.filter(account => account.id > input.cursor!) : accounts
    const selected = filtered.slice(0, input.limit)
    await this.authorize(this.pool, principal)
    return ProviderAccountPageSchema.parse({ revision: snapshot.revision, accounts: selected,
      defaults: snapshot.defaults, nextCursor: filtered.length > input.limit ? selected.at(-1)!.id : null })
  }

  async get(principal: ManagementPrincipal, raw: unknown): Promise<ProviderAccount> {
    const input = ProviderAccountGetInputSchema.parse(raw)
    await this.checkTarget(input.target)
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    const account = this.account(await this.repository.read(), input.accountId)
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    return account
  }

  private async status(account: ProviderAccount): Promise<Pick<ProviderAccount, 'status' | 'identity'>> {
    try {
      const paths = await this.profilePaths(account)
      if (account.authMode === 'api-key') {
        const apiKey = await this.credentials.apiKey(account.id)
        return { status: apiKey ? 'signed-in' : 'signed-out', identity: null }
      }
      const state = await this.native.status({ account, ...paths })
      return { status: state.status, identity: state.identity }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      return { status: 'unavailable', identity: null }
    }
  }

  private async profilePaths(account: ProviderAccount) {
    if (account.binding?.profileRef !== account.id) {
      if (!this.native.resolveProfile) throw new DomainError('PROVIDER_PROFILE_UNAVAILABLE',
        'The owning native installation must resolve this registered profile.', 409)
      return this.native.resolveProfile(account)
    }
    await this.credentials.assertAvailable(account.id)
    return this.credentials.paths(account.id)
  }

  private account(snapshot: ProviderAccountsSnapshot, accountId: string): ProviderAccount {
    ProviderAccountIdSchema.parse(accountId)
    const account = snapshot.accounts.find(value => value.id === accountId)
    if (!account) throw new DomainError('PROVIDER_ACCOUNT_NOT_FOUND', 'The account is unavailable on this computer.', 404)
    return account
  }

  private async change(principal: ManagementPrincipal, source: CommandSource, operation: string,
    input: { commandId: string; expectedRevision: number; target?: DeviceProvisioningTarget;
      expectedDefaultRevision?: number; expectedLabelRevision?: number },
    payload: unknown, change: Change,
    afterRollback?: () => Promise<void>) {
    const targetKey = await this.repository.key()
    const acceptedTarget = await this.repository.target()
    const accountId = (payload as { accountId?: string }).accountId
    await this.authorizeMutation(principal, source, operation, accountId, input.target)
    return this.commands.execute({
      principal, source, operation, commandId: input.commandId, targetKey, payload,
      resourceLock: `provider-account-credentials:${targetKey}`,
      replayResult: raw => {
        const snapshot = ProviderAccountsSnapshotSchema.parse(raw)
        if (snapshot.accounts.some(account => account.binding
          && !sameDeviceProvisioningTarget(account.binding.target, acceptedTarget))) {
          throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original command belongs to another installation.', 409)
        }
        return snapshot
      },
      authorize: sql => this.authorize(sql, principal, 'provider_accounts:manage', accountId),
      perform: async sql => {
        const snapshot = await this.repository.lock(sql)
        if (input.expectedDefaultRevision === undefined && input.expectedLabelRevision === undefined
          && snapshot.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Provider accounts changed. Refresh before saving.', 409)
        }
        await change(snapshot, sql)
        await this.authorize(sql, principal, 'provider_accounts:manage', accountId)
        return this.repository.write(sql, snapshot, snapshot.revision)
      },
      ...(afterRollback ? { afterRollback } : {}),
    }).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, operation, targetKey)
      }
      throw error
    })
  }

  create(principal: ManagementPrincipal, source: CommandSource, raw: unknown) {
    const input = ProviderAccountCreateInputSchema.parse(raw)
    let createdId: string | undefined
    return this.change(principal, source, 'provider.account.create', input, input, async snapshot => {
      if (snapshot.accounts.length >= 100) throw new DomainError('ACCOUNT_LIMIT', 'The account limit has been reached.', 409)
      const account: ProviderAccount = { id: randomUUID(), provider: input.provider, name: input.name,
        authMode: input.authMode, isDefault: !snapshot.accounts.some(value => value.provider === input.provider),
        status: 'signed-out', identity: null, revision: 1 }
      account.binding = ProviderAccountBindingSchema.parse({ kind: 'slot', accountId: account.id,
        provider: account.provider, target: await this.repository.target(), profileRef: account.id,
        bindingRevision: 1, subject: null })
      account.removedAt = null
      await this.credentials.create(account)
      createdId = account.id
      snapshot.accounts.push(account)
      if (account.isDefault) {
        const scoped = snapshot.defaults!.find(value => value.provider === account.provider)!
        scoped.accountId = account.id
        scoped.revision += 1
      }
    }, async () => {
      if (createdId) await this.credentials.removeCreatedHome(createdId)
    })
  }

  rename(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountRenameInputSchema.parse(raw)
    return this.change(principal, source, 'provider.account.rename', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      if (input.expectedLabelRevision !== undefined && account.revision !== input.expectedLabelRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The account label changed. Refresh before saving.', 409)
      }
      account.name = input.name
      account.revision += 1
    })
  }

  setDefault(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountDefaultInputSchema.parse(raw)
    return this.change(principal, source, 'provider.account.default.set', input, { ...input, accountId }, async snapshot => {
      const selected = this.account(snapshot, accountId)
      if (selected.removedAt) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'This account was removed from selection.', 409)
      const scoped = snapshot.defaults!.find(value => value.provider === selected.provider)!
      if (input.expectedDefaultRevision !== undefined && scoped.revision !== input.expectedDefaultRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The scoped default changed. Refresh before saving.', 409)
      }
      scoped.accountId = accountId
      scoped.revision += 1
      await this.credentials.assertAvailable(accountId)
      for (const account of snapshot.accounts.filter(value => value.provider === selected.provider)) {
        if (account.isDefault === (account.id === accountId)) continue
        account.isDefault = account.id === accountId
      }
    })
  }

  async refresh(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    await this.authorizeMutation(principal, source, 'provider.account.refresh', accountId, input.target)
    const active = await this.pool.query<{ id: string }>('select id from provider_account_authentication_operations '
      + 'where account_id=$1 and not native_closed', [accountId])
    if (active.rows[0]) await this.authentication.status(principal, active.rows[0].id, source)
    const before = this.account(await this.repository.read(), accountId)
    const observed = await this.status(before)
    const observation = this.native.observeAccount
      ? ProviderAccountObservationSchema.parse(await this.native.observeAccount({
        account: before, ...await this.profilePaths(before),
      })) : undefined
    return this.change(principal, source, 'provider.account.refresh', input, { ...input, accountId }, async (snapshot, sql) => {
      const account = this.account(snapshot, accountId)
      if (account.removedAt || !isDeepStrictEqual(account.binding, before.binding)) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The observed account changed before publication.', 409)
      }
      if (observation && account.binding?.bindingRevision !== observation.bindingRevision) {
        throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The observation names another binding revision.', 409)
      }
      const prior = account.observation
      if (observation && prior && (observation.generation < prior.generation
        || (observation.generation === prior.generation && observation.sequence <= prior.sequence))) return
      Object.assign(account, observed)
      if (observation) {
        if (account.observation?.subject && observation.subject
          && account.observation.subject.subject !== observation.subject.subject) {
          await assertAccountUnused(sql, account.id)
        }
        account.observation = observation
        account.status = observation.status
        account.identity = observation.identity
        account.possibleDuplicateAccountIds = observation.subject ? snapshot.accounts.filter(other =>
          other.id !== account.id && other.provider === account.provider
          && other.observation?.subject?.subject === observation.subject!.subject
          && isDeepStrictEqual(other.binding?.target, account.binding?.target)).map(other => other.id) : []
      }
    })
  }

  async prepareAuthentication(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountAuthenticationPrepareInputSchema.parse(raw)
    await this.authorizeMutation(principal, source, 'provider.account.auth.prepare', accountId, input.target)
    return this.authentication.prepare(principal, source, accountId, raw).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.status === 403) {
        await this.auditDenied(principal, source, 'provider.account.auth.prepare', accountId)
      }
      throw error
    })
  }

  async authenticationStatus(principal: ManagementPrincipal, raw: unknown, source: CommandSource = 'http') {
    const input = ProviderAccountAuthenticationReadInputSchema.parse(raw)
    await this.checkTarget(input.target)
    return this.authentication.status(principal, input.operationId, source)
  }

  async cancelAuthentication(principal: ManagementPrincipal, source: CommandSource, raw: unknown) {
    const input = ProviderAccountAuthenticationCancelInputSchema.parse(raw)
    const original = await this.authentication.read(input.operationId)
    await this.authorizeMutation(principal, source, 'provider.account.auth.cancel', original.binding.accountId, input.target)
    return this.authentication.cancel(principal, source, raw).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.status === 403) {
        await this.auditDenied(principal, source, 'provider.account.auth.cancel', original.binding.accountId)
      }
      throw error
    })
  }

  async login(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    const result = await this.prepareAuthentication(principal, source, accountId, { ...input, intent: 'sign-in' })
    await this.authorize(this.pool, principal, 'provider_accounts:read', accountId)
    return { value: await this.repository.read(), replayed: result.replayed }
  }

  async logout(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    const result = await this.prepareAuthentication(principal, source, accountId, { ...input, intent: 'sign-out' })
    await this.authorize(this.pool, principal, 'provider_accounts:read', accountId)
    return { value: await this.repository.read(), replayed: result.replayed }
  }

  remove(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    return this.change(principal, source, 'provider.account.remove', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      account.removedAt = new Date().toISOString()
      account.isDefault = false
      account.revision += 1
      const scoped = snapshot.defaults!.find(value => value.provider === account.provider)!
      if (scoped.accountId === accountId) {
        scoped.accountId = null
        scoped.revision += 1
      }
    })
  }

  async register(principal: ManagementPrincipal, source: CommandSource, raw: unknown) {
    const input = ProviderAccountRegisterInputSchema.parse(raw)
    await this.authorizeMutation(principal, source, 'provider.account.register', undefined, input.target)
    if (!this.native.registerProfile) throw new DomainError('PROVIDER_PROFILE_REGISTRATION_UNAVAILABLE',
      'This installation does not support qualified native profile registration.', 409)
    const target = await this.repository.target()
    const registered = await this.native.registerProfile({ provider: input.provider, profileRef: input.profileRef,
      qualificationId: input.qualificationId, target })
    return this.change(principal, source, 'provider.account.register', input, input, async snapshot => {
      if (snapshot.accounts.length >= 100) throw new DomainError('ACCOUNT_LIMIT', 'The account limit has been reached.', 409)
      if (snapshot.accounts.some(account => account.binding?.profileRef === registered.profileRef)) {
        throw new DomainError('PROVIDER_PROFILE_ALREADY_REGISTERED', 'This native profile is already registered.', 409)
      }
      const id = randomUUID()
      snapshot.accounts.push({ id, provider: input.provider, name: input.name, authMode: input.authMode,
        isDefault: false, status: 'unavailable', identity: null, revision: 1, removedAt: null,
        binding: { kind: 'slot', accountId: id, provider: input.provider, target,
          profileRef: registered.profileRef, bindingRevision: 1, subject: null } })
    })
  }

  async models(principal: ManagementPrincipal, raw: unknown): Promise<ProviderAccountModels> {
    const account = await this.get(principal, raw)
    if (account.removedAt || !this.native.models) throw new DomainError('PROVIDER_ACCOUNT_MODELS_UNAVAILABLE',
      'Model discovery is unavailable for this account/installation.', 409)
    const selected = await this.resolve(account.provider, account.id, { allowDefault: false })
    if (!selected?.binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The account binding is unavailable.', 409)
    const scoped = { ...account, binding: selected.binding }
    const result = ProviderAccountModelsSchema.parse(await this.native.models({
      account: scoped, ...await this.profilePaths(account),
    }))
    await this.authorize(this.pool, principal, 'provider_accounts:read', account.id)
    if (!isDeepStrictEqual(scoped.binding, result.binding)) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Model discovery returned another account binding.', 409)
    }
    const current = await this.resolve(account.provider, account.id, { allowDefault: false })
    if (!current?.binding || current.binding.subject?.subject !== result.binding.subject?.subject
      || !isDeepStrictEqual({ ...current.binding, subject: result.binding.subject }, result.binding)) {
      throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The account changed during model discovery.', 409)
    }
    return result
  }

  provisionApiKey(principal: ManagementPrincipal, accountId: string, raw: unknown) {
    const input = ProviderAccountApiKeyInputSchema.parse(raw)
    const { apiKey, ...command } = input
    const apiKeyDigest = createHash('sha256').update(apiKey).digest('hex')
    let backup: Map<string, Buffer | null> | undefined
    return this.change(principal, 'http', 'provider.account.key.provision', command,
      { ...command, accountId, apiKeyDigest }, async (snapshot, sql) => {
        const account = this.account(snapshot, accountId)
        if (account.legacyProfile) throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNKNOWN',
          'The original native profile has unproved historical ownership.', 409)
        if (account.provider !== 'claude' || account.authMode !== 'api-key') {
          throw new DomainError('ACCOUNT_AUTH_MODE_MISMATCH', 'This account uses provider subscription sign-in.', 409)
        }
        await assertAccountUnused(sql, accountId)
        const active = await sql.query('select 1 from provider_account_authentication_operations '
          + 'where account_id=$1 and not native_closed', [accountId])
        if (active.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING', 'Authentication is still pending.', 409)
        backup = await this.credentials.backup(account)
        await this.credentials.saveApiKey(accountId, apiKey)
        Object.assign(account, { status: 'signed-in', identity: null, revision: snapshot.revision + 1 })
      }, async () => { if (backup) await this.credentials.restore(backup) })
  }

  async resolve(provider: AccountProvider, accountId?: string,
    options?: { sql?: GraphSqlClient; allowDefault?: boolean;
      acceptedBinding?: AcceptedProviderAccountBinding }): Promise<ResolvedProviderAccount | null> {
    if (options?.acceptedBinding?.kind === 'legacy-profile') {
      const originalId = options.acceptedBinding.accountId
      if (accountId && accountId !== originalId) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work uses its original profile.', 409)
      }
      if (!originalId) return null
      return this.resolve(provider, originalId, { ...(options.sql ? { sql: options.sql } : {}), allowDefault: false })
    }
    const accepted = options?.acceptedBinding
    if (accepted && (accepted.provider !== provider || (accountId && accepted.accountId !== accountId))) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work names another account.', 409)
    }
    accountId = accepted?.accountId ?? accountId
    const snapshot = options?.sql ? await this.repository.lock(options.sql) : await this.repository.read()
    let account: ProviderAccount | undefined
    if (accountId) account = this.account(snapshot, accountId)
    else if (options?.allowDefault !== false) {
      account = snapshot.accounts.find(value => value.provider === provider && value.isDefault && !value.removedAt)
    }
    if (!account) return null
    if (!account.binding || !sameDeviceProvisioningTarget(account.binding.target, await this.repository.target())) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original account installation is unavailable.', 409)
    }
    if (account.removedAt) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The saved account was removed from selection.', 409)
    if (options?.sql) {
      const pending = await options.sql.query('select 1 from provider_account_authentication_operations '
        + 'where account_id=$1 and not native_closed', [account.id])
      if (pending.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING',
        'Authentication must be reconciled before accepting work for this account.', 409)
    }
    if (accepted && !isDeepStrictEqual(accepted, { ...account.binding, subject: accepted.subject })) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The accepted native account binding changed.', 409)
    }
    if (accepted?.subject && account.observation?.subject
      && account.observation.subject.subject !== accepted.subject.subject) {
      throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The saved provider principal cannot be verified.', 409)
    }
    if (account.provider !== provider) {
      throw new DomainError('PROVIDER_ACCOUNT_MISMATCH', 'The selected account belongs to another provider.', 409)
    }
    const paths = await this.profilePaths(account)
    if (!options?.sql && this.native.requireRuntimeAccount) {
      await this.native.requireRuntimeAccount({ account, ...paths })
    } else if (!options?.sql && this.native.authenticationGeneration) {
      await this.native.authenticationGeneration({ account, ...paths })
    }
    const apiKey = account.authMode === 'api-key' ? await this.credentials.apiKey(account.id) : undefined
    if (account.authMode === 'api-key' && !apiKey) {
      throw new DomainError('PROVIDER_ACCOUNT_SIGN_IN_REQUIRED', 'Add an API key to the selected account in Settings.', 409)
    }
    let binding = accepted ?? { ...account.binding, subject: account.observation?.subject ?? account.binding.subject }
    let observation: ProviderAccountObservation | undefined
    if (!options?.sql && account.authMode === 'subscription' && this.native.observeAccount) {
      observation = ProviderAccountObservationSchema.parse(await this.native.observeAccount({ account, ...paths }))
      if (observation.bindingRevision !== binding.bindingRevision
        || (binding.subject && observation.subject?.subject !== binding.subject.subject)) {
        throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The selected native principal changed or is unproved.', 409)
      }
      if (!accepted && observation.subject) binding = { ...binding, subject: observation.subject }
    }
    return { accountId: account.id, homePath: paths.homePath,
      authMode: account.authMode, binding, ...(observation ? { observation } : {}),
      ...(apiKey ? { apiKey } : {}) }
  }

  close(): Promise<void> { return this.native.close() }
}
