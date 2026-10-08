import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import type { ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ComputerAccountsService } from './accounts.js'

it('drops a cached Drive mount after a credential mutation so the next read probes the computer', async () => {
  const mainId = '11111111-1111-4111-8111-111111111111'
  let mounted = true
  let probes = 0
  const probe = async (): Promise<ComputerAccounts> => {
    probes++
    return { observedAt: new Date().toISOString(), accounts: [{ tool: 'drive', installed: true,
      signedIn: mounted, account: mounted ? 'owner@gmail.com' : null,
      details: mounted ? ['mount:/home/u/Foreman Code Drive'] : [],
    }] }
  }
  const accounts = new ComputerAccountsService({} as pg.Pool, mainId, () => undefined,
    {} as PostgresCommandCoordinator, probe)
  expect(await accounts.driveMount({ kind: 'main' })).toBe('/home/u/Foreman Code Drive')
  mounted = false
  expect(await accounts.driveMount({ kind: 'main' })).toBe('/home/u/Foreman Code Drive')
  accounts.invalidate({ hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
    keyRevision: null, authorizationRevision: null })
  expect(await accounts.driveMount({ kind: 'main' })).toBeNull()
  expect(probes).toBe(2)
})

it('pages every paired computer without silently dropping the 101st worker', async () => {
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read'], scope: {} }] }
  const registrations = Array.from({ length: 105 }, () => ({ mainId, deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
    scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) })).sort((a, b) => a.deviceId.localeCompare(b.deviceId))
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes('from management_principals')) return { rows: [{ ...principal,
      expires_at: new Date(principal.expiresAt), revoked_at: null }] }
    const cursor = values[1] as string | null
    return { rows: registrations.filter(value => !cursor || value.deviceId > cursor)
      .slice(0, text.includes('limit 100') ? 100 : 101).map(record => ({ record })) }
  }
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const service = new ComputerAccountsService(pool, mainId, () => undefined,
    {} as PostgresCommandCoordinator, async () => ({ accounts: [], observedAt: new Date().toISOString() }))
  const first = await service.list(principal)
  expect(first.computers).toHaveLength(101)
  expect(first.nextCursor).toBe(registrations[99]!.deviceId)
  const second = await service.list(principal, 'http', false, first.nextCursor!)
  expect(second.computers).toHaveLength(5)
  expect(second.nextCursor).toBeNull()
  expect([...first.computers, ...second.computers].map(value => value.target.hostRef))
    .toEqual([{ kind: 'main', mainId }, ...registrations.map(value => ({ kind: 'device', mainId, deviceId: value.deviceId }))])
})
