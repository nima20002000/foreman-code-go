import type pg from 'pg'
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
