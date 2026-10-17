import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { ProviderAccountConfigurationService } from '../harnesses/providerAccountConfiguration.js'
import { lockActiveWorkspace } from './admission.js'

interface ConfigurationInput {
  configuration: HarnessConfiguration
  selection: HarnessProfileSelection | undefined
}

/** Native profile setup may run nested commands and must precede database ownership. */
export function prepareAgentConfiguration(input: {
  pool: pg.Pool
  accounts: ProviderAccountConfigurationService
  principal: () => ManagementPrincipal
  workspaceId: string
  source: 'http' | 'mcp'
  commandId: string
  load: (client: pg.PoolClient) => Promise<ConfigurationInput>
}) {
  let snapshot: ConfigurationInput
  let prepared: ConfigurationInput
  return {
    value: () => prepared,
    command: {
      prepare: async () => {
        snapshot = await withTransaction(input.pool, input.load)
        prepared = await input.accounts.prepareProfile({ ...snapshot, pool: input.pool,
          principal: input.principal(), source: input.source, commandId: input.commandId })
      },
      preparedMutation: {
        releaseDuringPreparation: true as const,
        resourceLock: `admission:workspace:${input.workspaceId}`,
        validate: async (client: pg.PoolClient) => {
          await lockActiveWorkspace(client, input.workspaceId)
          return isDeepStrictEqual(snapshot, await input.load(client))
        },
      },
    },
  }
}
