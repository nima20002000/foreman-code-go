import { isDeepStrictEqual } from 'node:util'
import type {
  ProviderAccountNativeAuthenticationObservation, ProviderAccountAuthenticationOperation,
} from '@foreman-code/contracts/provider-accounts'
import type { ProviderAccountOperationNativePort } from './service.js'
import { NativeAccountJournal, type NativeAccountRecord } from './nativeJournal.js'
import {
  NativeProviderAccountCommands, type AccountCommandProcess, type ProviderAccountNativeInput,
} from './nativeCommands.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { DomainError } from '../errors.js'

type OperationInput = ProviderAccountNativeInput & { operation: ProviderAccountAuthenticationOperation }
type ProcessRegistry = Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'
  | 'closedRegistration' | 'scope'>
interface ResidentOperation { process: AccountCommandProcess; completion: Promise<void> }

/** Owns native effects after the shared service has committed an operation. */
export class NativeProviderAccountOperations implements ProviderAccountOperationNativePort {
  private readonly residents = new Map<string, ResidentOperation>()
  private readonly pending = new Map<string, Promise<ProviderAccountNativeAuthenticationObservation>>()
  private closing = false

  constructor(private readonly commands: NativeProviderAccountCommands,
    private readonly journal: NativeAccountJournal, private readonly processes: ProcessRegistry,
    private readonly eligibility: (input: OperationInput) => Promise<void>,
    private readonly now: () => number = Date.now) {
    this.commands.bindProcessRegistry(processes)
  }

  status(input: ProviderAccountNativeInput) {
    const record = input.account.binding ? this.journal.accountOperation(input.account.binding) : undefined
    if (record && !record.observation.nativeClosed) {
      return Promise.resolve({ status: 'login-pending' as const, identity: null })
    }
    return this.commands.status(input)
  }
  async observeAccount(input: ProviderAccountNativeInput) {
    const binding = input.account.binding
    if (!binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The account has no accepted native binding.', 409)
    const record = this.journal.accountOperation(binding)
    if (record && !record.observation.nativeClosed) {
      return this.journal.saveObservation(binding, { bindingRevision: binding.bindingRevision,
        generation: record.operation.generation, sequence: record.observation.sequence,
        observedAt: new Date(this.now()).toISOString(), status: 'login-pending', identity: null,
        subject: null, readiness: 'unknown' })
    }
    return this.journal.saveObservation(binding, await this.commands.observeAccount(input))
  }
  models(input: ProviderAccountNativeInput) { return this.commands.models(input) }
  resolveProfile(account: ProviderAccountNativeInput['account']) { return this.commands.resolveProfile(account) }
  registerProfile(input: Parameters<NativeProviderAccountCommands['registerProfile']>[0]) {
    return this.commands.registerProfile(input)
  }
  login(input: ProviderAccountNativeInput) { return this.commands.login(input) }
  logout(input: ProviderAccountNativeInput) { return this.commands.logout(input) }
  cancelLogin(accountId: string) { return this.commands.cancelLogin(accountId) }

  private update(record: NativeAccountRecord, state: NativeAccountRecord['observation']['state'], closed: boolean) {
    record.observation = { ...record.observation, state, nativeClosed: closed,
      sequence: record.observation.sequence + 1 }
    this.journal.write(record)
  }

  private validate(input: OperationInput, record: NativeAccountRecord): void {
    if (!isDeepStrictEqual(record.operation.binding, input.account.binding)
      || record.operation.binding.accountId !== input.account.id
      || record.operation.binding.provider !== input.account.provider
      || record.operation.intent === 'sign-in' && input.account.authMode !== 'subscription') {
      throw new DomainError('PROVIDER_OPERATION_CONFLICT', 'The native operation differs from its accepted account.', 409)
    }
  }

  prepareAuthentication(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    const previous = this.pending.get(input.operation.id)
    if (previous) return previous.then(() => this.observeAuthentication(input))
    const pending = this.prepare(input).finally(() => { this.pending.delete(input.operation.id) })
    this.pending.set(input.operation.id, pending)
    return pending
  }

  private async prepare(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    if (this.closing) throw new DomainError('PROVIDER_OPERATIONS_CLOSING', 'Account operations are shutting down.', 503)
    const { record, created } = this.journal.reserve(input.operation)
    this.validate(input, record)
    if (!created) return this.observeAuthentication(input)
    if (input.operation.cancelRequested || Date.parse(input.operation.expiresAt) <= this.now()) {
      this.update(record, input.operation.cancelRequested ? 'canceled' : 'expired', true)
      return structuredClone(record.observation)
    }
    let installation: Awaited<ReturnType<NativeProviderAccountCommands['selected']>>
    try {
      await this.eligibility(input)
      installation = await this.commands.selected(input)
    } catch (error) {
      this.update(record, 'failed', true)
      throw error
    }
    if (this.closing) throw new DomainError('PROVIDER_OPERATIONS_CLOSING', 'Account operations are shutting down.', 503)
    const checked = this.journal.read(record.operation.id)!
    if (checked.operation.cancelRequested || checked.observation.nativeClosed) return structuredClone(checked.observation)
    const recovery = this.processes.reserveLaunch(record.owner)
    if (!recovery.launchId) throw new DomainError('PROVIDER_OPERATION_UNSUPPORTED',
      'This host cannot retain native account process ownership.', 409)
    record.launchId = recovery.launchId
    this.journal.write(record)
    let process: AccountCommandProcess
    try {
      record.dispatched = true
      this.update(record, input.operation.intent === 'sign-in' ? 'awaiting-human' : 'observing', false)
      process = await this.commands.dispatch(input, input.operation.intent === 'sign-in' ? 'login' : 'logout',
        recovery, installation, () => {
          const current = this.journal.read(record.operation.id)!
          if (current.operation.cancelRequested || current.observation.nativeClosed || this.closing) {
            throw new DomainError('PROVIDER_OPERATION_CANCELED', 'The original native operation is no longer dispatchable.', 409)
          }
        })
    } catch {
      await this.processes.abandonReservedLaunch(recovery)
      const closed = await this.processes.closeOwner(record.owner)
      const current = this.journal.read(record.operation.id)!
      let state: NativeAccountRecord['observation']['state'] = 'outcome-unknown'
      if (closed) state = current.operation.cancelRequested ? 'canceled' : 'failed'
      this.update(current, state, closed)
      return structuredClone(current.observation)
    }
    let closureConfirmed = false
    const completion = process.completion.then(async result => {
      let current = this.journal.read(record.operation.id)!
      const closed = await this.processes.closeOwner(current.owner)
      closureConfirmed = closed
      current = this.journal.read(record.operation.id)!
      if (!closed) { this.update(current, 'outcome-unknown', false); return }
      if (current.operation.cancelRequested || Date.parse(current.operation.expiresAt) <= this.now()) {
        this.update(current, current.operation.cancelRequested ? 'canceled' : 'expired', true)
        return
      }
      await this.eligibility(input)
      const selected = await this.commands.selected(input)
      current = this.journal.read(record.operation.id)!
      if (current.operation.cancelRequested || Date.parse(current.operation.expiresAt) <= this.now()) {
        this.update(current, current.operation.cancelRequested ? 'canceled' : 'expired', true)
        return
      }
      if (!isDeepStrictEqual(installation, selected)) { this.update(current, 'outcome-unknown', true); return }
      let state: NativeAccountRecord['observation']['state'] = 'failed'
      if (result.timedOut) state = 'expired'
      else if (result.code === 0) state = 'completed'
      this.update(current, state, true)
    }).catch(async () => {
      const current = this.journal.read(record.operation.id)!
      this.update(current, 'outcome-unknown', closureConfirmed)
    }).finally(() => { this.residents.delete(record.operation.id) })
    this.residents.set(record.operation.id, { process, completion })
    return structuredClone(record.observation)
  }

  async observeAuthentication(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    const { record } = this.journal.reserve(input.operation)
    this.validate(input, record)
    if (record.observation.nativeClosed) return structuredClone(record.observation)
    if (input.operation.cancelRequested) return this.cancel(input, 'canceled')
    const resident = this.residents.get(record.operation.id)
    if (resident) {
      if (Date.parse(record.operation.expiresAt) <= this.now()) return this.cancel(input, 'expired')
      return structuredClone(record.observation)
    }
    const closed = record.launchId && this.processes.closedRegistration(record.owner, record.launchId)
    if (closed) {
      const state = record.operation.cancelRequested ? 'canceled' : 'outcome-unknown'
      this.update(record, state, true)
    } else this.update(record, 'outcome-unknown', false)
    return structuredClone(record.observation)
  }

  cancelAuthentication(input: OperationInput): Promise<ProviderAccountNativeAuthenticationObservation> {
    return this.cancel(input, 'canceled')
  }

  private async cancel(input: OperationInput, state: 'canceled' | 'expired') {
    const { record } = this.journal.reserve(input.operation)
    this.validate(input, record)
    if (record.observation.nativeClosed) return structuredClone(record.observation)
    record.operation.cancelRequested = true
    this.update(record, 'observing', record.observation.nativeClosed)
    try {
      const resident = this.residents.get(record.operation.id)
      if (resident) { await resident.process.stop(); await resident.completion }
      const closed = record.launchId ? await this.processes.closeOwner(record.owner) : !record.dispatched
      const current = this.journal.read(record.operation.id)!
      this.update(current, closed ? state : 'outcome-unknown', closed)
      return structuredClone(current.observation)
    } catch {
      const current = this.journal.read(record.operation.id)!
      this.update(current, 'outcome-unknown', false)
      return structuredClone(current.observation)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending.values()])
    const failures: unknown[] = []
    for (const id of this.residents.keys()) {
      const record = this.journal.read(id)!
      try {
        await this.residents.get(id)!.process.stop()
        await this.residents.get(id)?.completion
        if (!await this.processes.closeOwner(record.owner)) throw new Error('Native account cleanup is unconfirmed.')
      } catch (error) { failures.push(error) }
    }
    try { await this.commands.close() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Native account cleanup remains unconfirmed.')
  }
}


it('persists monotonic account observations across native journal restart', async () => {
  const f = await fixture()
  const value = input()
  await f.native.prepareAuthentication(value)
  const first = await f.native.observeAccount(value)
  const second = await f.restart().observeAccount(value)
  expect(first.status).toBe('login-pending')
  expect(second.sequence).toBeGreaterThan(first.sequence)
  expect(second.bindingRevision).toBe(value.operation.binding.bindingRevision)
  await f.native.cancelAuthentication(value)
})

it('rejects same-path slot adoption by a changed installation even after native closure', async () => {
  const f = await fixture()
  const value = input()
  await f.native.prepareAuthentication(value)
  await f.native.cancelAuthentication(value)
  const reinstalled = structuredClone(value)
  reinstalled.account.binding!.target.applicationInstallationId = randomUUID()
  reinstalled.operation.binding = reinstalled.account.binding!
  reinstalled.operation.id = randomUUID()
  reinstalled.operation.commandId = randomUUID()
  await expect(f.restart().prepareAuthentication(reinstalled)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
  expect(f.invocations).toHaveLength(1)
})
