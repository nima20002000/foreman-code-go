import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@graphql/contracts/harness-registry'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks, nativeProfileCheckId } from '../src/modules/harnesses/instanceSettings/profileChecks.js'

const mainId = '00000000-0000-4000-8000-000000000001'
const principal: ManagementPrincipal = { id: 'writer', name: 'Writer', audience: 'operator', revokedAt: null, expiresAt: '9999-12-31T00:00:00.000Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
function fixture() {
  let current: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: '1', target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'codex', installationFingerprint: 'sha' },
    presetId: 'local-default:codex', driverId: 'codex', enabled: true, configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }, configurationFingerprint: 'profile-sha', qualification: 'unqualified' }
  const client = { query: vi.fn(async () => undefined) } as unknown as pg.PoolClient
  let readTransaction = false
  const settings = { latest: async () => structuredClone(current), lockRevision: vi.fn(async () => undefined),
    readAuthorized: async (work: (client: pg.PoolClient) => Promise<unknown>) => { readTransaction = true; try { return await work(client) } finally { readTransaction = false } } } as unknown as HarnessInstanceSettingsRepository
  const stored = new Map<string, HostHarnessProfileEvidence>()
  const append = vi.fn(async (_client: pg.PoolClient, checkId: string, _value: HostHarnessOverride, proof: HostHarnessProfileEvidence) => { stored.set(checkId, proof) })
  const proofs = { findCheck: async (id: string) => stored.get(id) ?? null, append } as unknown as HostHarnessProfileEvidenceRepository
  const commands = { execute: vi.fn(async (command: { authorize: (client: pg.PoolClient) => Promise<void>; perform: (client: pg.PoolClient) => Promise<unknown> }) => {
    await command.authorize(client); return { value: await command.perform(client), replayed: false }
  }) } as unknown as PostgresCommandCoordinator
  const authorize = vi.fn(async () => undefined)
  const proof = (value: HostHarnessOverride): HostHarnessProfileEvidence => ({ target: value.target, instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
    driverRevision: '1', protocolRevision: '1', suiteRevision: 'suite', environmentGeneration: 'env', connectionGeneration: 'local', authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString() })
  const qualify = vi.fn(async (value: HostHarnessOverride) => { expect(readTransaction).toBe(false); return proof(value) })
  const service = new HostHarnessInstanceProfileChecks(settings, proofs, commands, { authorize }, { qualify })
  const input = { commandId: randomUUID(), instanceId: current.instanceId, expectedRevision: current.revision, target: current.target }
  return { service, qualify, append, proof, input, authorize, settings, commands, change: () => { current = { ...current, revision: 2, instanceRevision: '2' } } }
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
