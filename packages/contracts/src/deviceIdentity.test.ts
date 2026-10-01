import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authorizeDevice, revokeDevice, type DevicePrincipal, type DeviceRegistration } from './deviceIdentity.js'
import { loadOrCreateWorkerIdentity } from './deviceIdentityNode.js'

describe('device authority and durable local identity', () => {
  it('fences revoked, wrong-main, expired and stale authorization revisions', () => {
    const registration: DeviceRegistration = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }
    const principal: DevicePrincipal = { audience: 'graphql-worker', ...registration, expiresAt: new Date(10_000).toISOString() }
    expect(authorizeDevice(registration, principal, 'connect', 0)).toBe(true)
    expect(authorizeDevice(registration, principal, 'heartbeat', 0)).toBe(false)
    expect(authorizeDevice(registration, { ...principal, mainId: randomUUID() }, 'connect', 0)).toBe(false)
    expect(authorizeDevice(registration, principal, 'connect', 10_000)).toBe(false)
    const revoked = revokeDevice(registration)
    expect(revoked.authorizationRevision).toBe(2)
    expect(revokeDevice(revoked)).toBe(revoked)
    expect(authorizeDevice(revoked, principal, 'connect', 0)).toBe(false)
  })
  it('atomically converges concurrent starts, persists restart identity and refuses corrupt identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'device-identity-'))
    try {
      const identities = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateWorkerIdentity(directory)))
      expect(new Set(identities.map(identity => identity.workerInstallationId)).size).toBe(1)
      expect(await loadOrCreateWorkerIdentity(directory)).toEqual(identities[0])
      const stored = await readFile(join(directory, 'identity.json'), 'utf8')
      await writeFile(join(directory, 'identity.json'), '')
      await expect(loadOrCreateWorkerIdentity(directory)).rejects.toThrow()
      expect(await readFile(join(directory, 'identity.json'), 'utf8')).toBe('')
      await writeFile(join(directory, 'identity.json'), stored.replace('"keyRevision":1', '"keyRevision":2'))
      await expect(loadOrCreateWorkerIdentity(directory)).rejects.toThrow('corrupt')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
