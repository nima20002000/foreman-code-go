import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks, nativeProfileCheckId } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { assertDeviceHostInstallation } from '../src/modules/devices/hostAuthorization.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import type { HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'

vi.mock('../src/modules/devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: vi.fn() }))

const mainId = '00000000-0000-4000-8000-000000000001'
const principal: ManagementPrincipal = { id: 'writer', name: 'Writer', audience: 'operator', revokedAt: null, expiresAt: '9999-12-31T00:00:00.000Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
function fixture() {
  let current: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: '1', target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'codex', installationFingerprint: 'sha' },
    presetId: 'local-default:codex', driverId: 'codex', enabled: true, configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }, configurationFingerprint: 'profile-sha', qualification: 'unqualified' }
  const client = { query: vi.fn(async () => undefined) } as unknown as pg.PoolClient
  let readTransaction = false
  const settings = { latest: async () => structuredClone(current), list: async () => [structuredClone(current)],
    withProfileConnection: async (work: (client: pg.PoolClient) => Promise<unknown>) => work(client),
    lockRevision: vi.fn(async () => undefined),
    readAuthorized: async (work: (client: pg.PoolClient) => Promise<unknown>) => { readTransaction = true; try { return await work(client) } finally { readTransaction = false } } } as unknown as HarnessInstanceSettingsRepository
  const stored = new Map<string, HostHarnessProfileEvidence>()
  const append = vi.fn(async (_client: pg.PoolClient, checkId: string, _value: HostHarnessOverride, proof: HostHarnessProfileEvidence) => { stored.set(checkId, proof) })
  const proofs = { findCheck: async (id: string) => stored.get(id) ?? null,
    latest: async () => [...stored.values()].at(-1) ?? null,
    previouslyQualified: async () => [...stored.values()].some(value => value.qualified),
    append } as unknown as HostHarnessProfileEvidenceRepository
  const commands = { execute: vi.fn(async (command: { authorize: (client: pg.PoolClient) => Promise<void>; perform: (client: pg.PoolClient) => Promise<unknown> }) => {
    await command.authorize(client); return { value: await command.perform(client), replayed: false }
  }) } as unknown as PostgresCommandCoordinator
  const authorize = vi.fn(async () => undefined)
  const proof = (value: HostHarnessOverride): HostHarnessProfileEvidence => ({ target: value.target, instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
    driverRevision: '1', protocolRevision: '1', suiteRevision: 'suite', environmentGeneration: 'env', connectionGeneration: 'local', authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString() })
  const qualify = vi.fn(async (value: HostHarnessOverride) => { expect(readTransaction).toBe(false); return proof(value) })
  const service = new HostHarnessInstanceProfileChecks(settings, proofs, commands, { authorize }, { qualify })
  const input = { commandId: randomUUID(), instanceId: current.instanceId, expectedRevision: current.revision, target: current.target }
  return { service, qualify, append, proof, input, authorize, settings, commands,
    seed: (evidence: HostHarnessProfileEvidence) => stored.set('previous', evidence),
    setOverride: (value: HostHarnessOverride) => { current = value },
    change: () => { current = { ...current, revision: 2, instanceRevision: '2' } } }
}
describe('explicit exact-host native profile checks', () => {
  it('checks outside authority transactions and recovers persisted proof without repeating native effects', async () => {
    const f = fixture()
    const first = await f.service.check(principal, 'mcp', f.input)
    expect(first.value.proof.qualified).toBe(true)
    expect(f.commands.execute).toHaveBeenCalledWith(expect.objectContaining({ dedicatedConnection: true, operation: 'harness.instance.check' }))
    expect(f.settings.lockRevision).toHaveBeenCalled()
    expect((await f.service.check(principal, 'http', f.input)).value.proof).toEqual(first.value.proof)
    expect(f.qualify).toHaveBeenCalledTimes(1)
    await f.service.close()
  })
  it('requires both grants and rejects another target profile or a concurrently changed revision', async () => {
    const f = fixture()
    await expect(f.service.check({ ...principal, grants: [{ actions: ['harnesses:read'], scope: {} }] }, 'mcp', f.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    f.qualify.mockImplementationOnce(async value => ({ ...f.proof(value), configurationFingerprint: 'other' }))
    await expect(f.service.check(principal, 'mcp', f.input)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_EVIDENCE_MISMATCH' })
    f.qualify.mockImplementationOnce(async value => { f.change(); return f.proof(value) })
    await expect(f.service.check(principal, 'mcp', f.input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
  it('aborts and joins owned checks on shutdown without persisting a late success', async () => {
    const f = fixture()
    let started!: () => void
    const admitted = new Promise<void>(resolve => { started = resolve })
    f.qualify.mockImplementationOnce(async value => { started(); await new Promise<void>(resolve => setTimeout(resolve, 10)); return f.proof(value) })
    const check = f.service.check(principal, 'http', f.input)
    await admitted
    const rejected = expect(check).rejects.toThrow('stopping')
    await f.service.close(); await rejected
    expect(f.append).not.toHaveBeenCalled()
    await expect(f.service.check(principal, 'http', f.input)).rejects.toMatchObject({ code: 'HARNESS_CHECK_SHUTTING_DOWN' })
  })
  it('keeps native check identity distinct from caller command and other principals/mains', () => {
    const commandId = randomUUID(), id = nativeProfileCheckId(mainId, principal.id, commandId)
    expect(id).not.toBe(commandId)
    expect(nativeProfileCheckId(mainId, principal.id, commandId)).toBe(id)
    expect(nativeProfileCheckId(mainId, 'other', commandId)).not.toBe(id)
    expect(nativeProfileCheckId('other-main', principal.id, commandId)).not.toBe(id)
  })
})

function workerFixture() {
  const f = fixture()
  const binding = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 2, connectionEpoch: randomUUID() }
  const host = { kind: 'device' as const, mainId, deviceId: binding.deviceId }
  const override: HostHarnessOverride = { instanceId: f.input.instanceId, revision: 1, instanceRevision: '1',
    target: { ...f.input.target, hostRef: host, applicationInstallationId: binding.workerInstallationId },
    presetId: 'worker-codex', driverId: 'codex', enabled: true,
    configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' },
    configurationFingerprint: 'profile-sha', qualification: 'unqualified' }
  f.setOverride(override)
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ ...binding,
    publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] })
  f.qualify.mockImplementation(async selected => ({ ...f.proof(selected),
    connectionGeneration: harnessConnectionGeneration(binding) }))
  return { ...f, binding, host, override }
}

describe('automatic installation profile checks', () => {
  function updatedFixture() {
    const f = fixture()
    const saved = { instanceId: f.input.instanceId, revision: 1, instanceRevision: '1', target: f.input.target,
      presetId: 'local-default:codex', driverId: 'codex', enabled: true, qualification: 'unqualified' as const,
      configuration: { harness: 'codex' as const, model: 'test', reasoningEffort: 'high' as const,
        sandbox: 'read-only' as const, serviceTier: 'standard' as const }, configurationFingerprint: 'profile-sha' }
    f.seed(f.proof(saved))
    const installation: HarnessInstallationRecord = { hostRef: saved.target.hostRef,
      harnessInstallationId: saved.target.harnessInstallationId, installationFingerprint: 'updated-fingerprint',
      driverId: 'codex', driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
      environmentGeneration: 'env', connectionGeneration: 'local', observedVersion: null,
      installed: true, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex',
        fingerprint: 'updated-fingerprint', status: 'installed', interpreter: null, diagnostics: [],
        checkedAt: new Date().toISOString(),
        environment: { generation: 'env', provenance: 'terminal', cwd: '/workspace', path: '/usr/bin' } } }
    f.settings.replaceInstallation = vi.fn(async (_client, previous, target) => {
      const value = { ...previous, target, revision: previous.revision + 1 }
      f.setOverride(value)
      return value
    })
    const authorize = vi.fn(async () => {})
    const request = { host: saved.target.hostRef, driverId: 'codex', applicationInstallationId: mainId,
      generation: 'updated-generation', signal: new AbortController().signal, authorize,
      installation: () => installation }
    return { ...f, saved, installation, request }
  }
  it('leaves qualified Codex profiles and their proofs unchanged after a Claude installation update', async () => {
    const f = updatedFixture()
    const beforeChecks = vi.fn(async () => {})
    await f.service.recheckInstallation({ ...f.request, driverId: 'claude', beforeChecks })
    expect(beforeChecks).not.toHaveBeenCalled()
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.settings.replaceInstallation).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
  it('deduplicates an update and reports pending until the replacement profile is persisted', async () => {
    const f = updatedFixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    f.qualify.mockImplementationOnce(async selected => {
      started()
      await waiting
      return f.proof(selected)
    })
    const task = f.service.recheckInstallation(f.request)
    expect(f.service.recheckInstallation(f.request)).toBe(task)
    await entered
    expect(() => f.service.assertReady(f.request.host)).toThrow(expect.objectContaining({ code: 'HARNESS_PROFILE_CHECK_PENDING' }))
    release()
    await task
    expect(() => f.service.assertReady(f.request.host)).not.toThrow()
    const selected = f.qualify.mock.calls[0]![0]
    expect(selected.instanceRevision).toBe(f.saved.instanceRevision)
    expect(selected.revision).toBe(2)
    expect(selected.configuration).toEqual(f.saved.configuration)
    expect(selected.target.installationFingerprint).toBe(f.installation.installationFingerprint)
    expect(f.append).toHaveBeenCalledTimes(1)
    await f.service.close()
  })
  it('persists a thrown qualification failure with a reason on the updated profile', async () => {
    const f = updatedFixture()
    f.qualify.mockRejectedValueOnce(new Error('Native check failed'))
    await expect(f.service.recheckInstallation(f.request)).rejects.toThrow('Automatic harness profile checks failed')
    const proof = f.append.mock.calls[0]![3]
    expect(proof.qualified).toBe(false)
    expect(proof.target.installationFingerprint).toBe(f.installation.installationFingerprint)
    expect(proof.failure).toMatchObject({ code: 'HARNESS_QUALIFICATION_FAILED' })
    expect(proof.failure!.message).not.toContain('Native check failed')
    expect(f.service.pending(f.request.host)).toBe(false)
    await f.service.close()
  })
  it('refuses to retain success when the host authority changes during the native check', async () => {
    const f = updatedFixture()
    f.qualify.mockImplementationOnce(async selected => {
      f.request.authorize.mockRejectedValue(new Error('Host registration changed'))
      return f.proof(selected)
    })
    await expect(f.service.recheckInstallation(f.request)).rejects.toThrow('Host registration changed')
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
})

describe('Worker reconnect profile checks', () => {
  it('checks an enabled qualified profile once per connection and refuses Start while it runs', async () => {
    const f = workerFixture()
    f.seed(f.proof(f.override))
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    f.qualify.mockImplementationOnce(async selected => {
      started()
      await waiting
      return { ...f.proof(selected), connectionGeneration: harnessConnectionGeneration(f.binding) }
    })
    const signal = new AbortController().signal
    const task = f.service.recheckWorker(f.binding, signal, () => f.binding)
    expect(f.service.recheckWorker(f.binding, signal, () => f.binding)).toBe(task)
    await entered
    expect(() => f.service.assertReady(f.host)).toThrow(expect.objectContaining({
      code: 'HARNESS_PROFILE_CHECK_PENDING', details: expect.objectContaining({ retryable: true }),
    }))
    release()
    await task
    expect(() => f.service.assertReady(f.host)).not.toThrow()
    await f.service.recheckWorker(f.binding, signal, () => f.binding)
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.append).toHaveBeenCalledTimes(1)
    await f.service.close()
  })

  it.each(['disabled', 'unqualified', 'never-checked'] as const)('leaves a %s profile unchecked', async state => {
    const f = workerFixture()
    if (state !== 'never-checked') f.seed({ ...f.proof(f.override), qualified: state !== 'unqualified' })
    if (state === 'disabled') f.setOverride({ ...f.override, enabled: false })
    await f.service.recheckWorker(f.binding, new AbortController().signal, () => f.binding)
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })

  it('discards a successful native result when the connection changes before persistence', async () => {
    const f = workerFixture()
    f.seed(f.proof(f.override))
    let current = f.binding
    f.qualify.mockImplementationOnce(async selected => {
      current = { ...current, connectionGeneration: 3 }
      return { ...f.proof(selected), connectionGeneration: harnessConnectionGeneration(f.binding) }
    })
    await expect(f.service.recheckWorker(f.binding, new AbortController().signal, () => current))
      .rejects.toThrow('Automatic Worker profile checks failed')
    expect(f.append).not.toHaveBeenCalled()
    expect(() => f.service.assertReady(f.host)).not.toThrow()
    await f.service.close()
  })
})
