import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { describe, expect, it, vi } from 'vitest'
import { inspectInstalledCodex, readInstalledCodexQualification } from '../src/modules/harnesses/installedCodexInspection.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import type { HarnessQualification } from '@graphql/contracts/harness-qualification'

async function fixture(version = '0.132.0') {
  const root = await mkdtemp(join(tmpdir(), 'installed-codex-inspection-'))
  const binary = join(root, 'codex')
  // File bytes only; this fixture is never an executable provider/probe.
  await writeFile(binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('actual-fixture-image')]), { mode: 0o700 })
  const path = join(root, 'installed-workflow.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, codexBinary: binary, appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: version, payloadPaths: [] }), { mode: 0o600 })
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const input = { binding, configuration: { path, ownerUid: process.getuid!() }, environment: { PATH: '/usr/bin' }, cwd: root, signal: new AbortController().signal }
  return { root, binary, path, input }
}
function proof(target: NonNullable<Awaited<ReturnType<typeof inspectInstalledCodex>>['currentTarget']>): HarnessQualification {
  return { harness: 'codex', version: target.expectedVersion, binarySha256: target.binarySha256,
    suiteRevision: 'actual-suite-v1', profile: 'codex-0.156', status: 'qualified',
    checks: [{ id: 'native-protocol-and-live-turn', passed: true, detail: null }], failureReason: null,
    startedAt: '2026-10-01T00:00:00.000Z', checkedAt: '2026-10-01T00:01:00.000Z' }
}

describe('passive installed worker Codex evidence producer', () => {
  it('derives installed metadata and the exact W07 tuple without promoting 0.132 selection or login to trust', async () => {
    const f = await fixture()
    try {
      const result = await inspectInstalledCodex(f.input)
      const target = result.currentTarget!
      expect(target.expectedVersion).toBe('0.132.0')
      expect(target.binarySha256).toBe(createHash('sha256').update(await readFile(f.binary)).digest('hex'))
      expect(result.inventory.instances).toEqual([])
      expect(result.inventory.installations[0]).toMatchObject({ driverId: 'codex', installed: true,
        connectionGeneration: harnessConnectionGeneration(f.input.binding), observedVersion: null,
        authenticated: null, compatible: null, qualified: false })
      expect(result.inventory.hostMetadata).toMatchObject({ hostRef: { kind: 'device', mainId: f.input.binding.mainId, deviceId: f.input.binding.deviceId }, applicationInstallationId: f.input.binding.workerInstallationId })
      expect(target.target.installationFingerprint).toBe(result.inventory.installations[0]?.installationFingerprint)
      const find = vi.fn(async () => null)
      expect(await readInstalledCodexQualification({ find }, target, 'actual-suite-v1')).toBeNull()
      expect(find).toHaveBeenCalledWith('codex', '0.132.0', target.binarySha256, 'actual-suite-v1')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('detects actual changed executable and payload bytes in the target fingerprint', async () => {
    const f = await fixture()
    try {
      const payload = join(f.root, 'provider-payload')
      await writeFile(payload, 'payload-one')
      await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: f.binary, appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: '0.132.0', payloadPaths: [payload] }), { mode: 0o600 })
      const before = await inspectInstalledCodex(f.input)
      await writeFile(payload, 'payload-two')
      const afterPayload = await inspectInstalledCodex(f.input)
      expect(afterPayload.currentTarget?.target.installationFingerprint).not.toBe(before.currentTarget?.target.installationFingerprint)
      expect(afterPayload.currentTarget?.binarySha256).toBe(before.currentTarget?.binarySha256)
      await writeFile(f.binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('replacement-image')]))
      const afterBinary = await inspectInstalledCodex(f.input)
      expect(afterBinary.currentTarget?.binarySha256).not.toBe(before.currentTarget?.binarySha256)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('returns unavailable selection without scanning PATH when configuration is absent and rejects local trust flags', async () => {
    const f = await fixture()
    try {
      expect((await inspectInstalledCodex({ ...f.input, configuration: null })).inventory.installations).toEqual([])
      await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: f.binary, appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: '0.132.0', payloadPaths: [], qualified: true }), { mode: 0o600 })
      await expect(inspectInstalledCodex(f.input)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      await chmod(f.path, 0o644)
      await expect(inspectInstalledCodex(f.input)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('keeps arbitrary executable scripts unqualified even when explicitly selected', async () => {
    const f = await fixture()
    try {
      await writeFile(f.binary, '#!/bin/sh\nexit 0\n')
      const result = await inspectInstalledCodex(f.input)
      expect(result.inventory.installations[0]).toMatchObject({ installed: true, installationFingerprint: null, qualified: false })
      expect(result.currentTarget).toBeNull()
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('requires the genuine exact current suite, SHA, profile, completed checks and positive persisted status', async () => {
    const f = await fixture()
    try {
      const target = (await inspectInstalledCodex(f.input)).currentTarget!
      const original = proof(target)
      expect(await readInstalledCodexQualification({ find: async () => original }, target, 'actual-suite-v1')).toEqual(original)
      for (const changed of [ { status: 'unqualified' as const }, { status: 'baseline' as const }, { version: '0.154.0' },
        { binarySha256: 'a'.repeat(64) }, { suiteRevision: 'stale-suite' }, { checkedAt: null }, { checks: [] },
        { profile: 'codex-0.154' as const }, { checks: [{ id: 'native-protocol-and-live-turn', passed: false, detail: null }] } ]) {
        expect(await readInstalledCodexQualification({ find: async () => ({ ...original, ...changed }) }, target, 'actual-suite-v1')).toBeNull()
      }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('retains the passive report only on its current authenticated Main binding and revalidates read grants', async () => {
    const f = await fixture()
    let permitted = true
    let connected = true
    const binding = f.input.binding
    const principal: ManagementPrincipal = { id: 'operator-fixture', name: 'Read fixture', audience: 'operator', revokedAt: null,
      expiresAt: '9999-01-01T00:00:00.000Z', grants: [{ actions: ['harnesses:read'], scope: {} }] }
    const registration = { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
      publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
    const client = { release: () => undefined, query: async (sql: string) => {
      if (sql.includes('worker_installation_id::text')) return { rows: [{ id: binding.workerInstallationId }] }
      if (sql.includes('management_principals')) return { rows: [{ id: principal.id, name: principal.name, audience: 'operator',
        grants: permitted ? principal.grants : [], expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
      if (sql.includes('application_installation')) return { rows: [{ id: binding.mainId }] }
      if (sql.includes('device_registrations')) return { rows: [{ record: registration }] }
      return { rows: [] }
    } }
    const pool = { connect: async () => client } as unknown as pg.Pool
    const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'not-probed', openCodeBinary: 'not-probed' },
      async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), new HostHarnessProfileEvidenceRepository(pool),
      () => connected ? binding : null, {})
    try {
      const report = (await inspectInstalledCodex(f.input)).inventory
      registry.acceptRemoteSnapshot(binding, report)
      const host = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
      const readback = await registry.get(principal, host)
      expect(readback.installations).toEqual(report.installations)
      expect(readback.installations[0]?.qualified).toBe(false)
      expect(() => registry.acceptRemoteSnapshot({ ...binding, connectionEpoch: randomUUID() }, report)).toThrow('unavailable connection generation')
      permitted = false
      await expect(registry.get(principal, host)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      connected = false
      expect(() => registry.acceptRemoteSnapshot(binding, report)).toThrow('unavailable connection generation')
    } finally { registry.stop(); await rm(f.root, { recursive: true, force: true }) }
  })

})
