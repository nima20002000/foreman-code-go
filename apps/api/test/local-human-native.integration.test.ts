import { describe, it } from 'vitest'
import { runCommand } from '../src/modules/harnesses/process.js'
import { nativeHttpIsolation } from './helpers/nativeHttpIsolation.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('native process local-human isolation', { timeout: 60_000 }, () => {
  it('denies tokenless mutations and approvals while retaining credentialed MCP access', async () => {
    await nativeHttpIsolation(input => runCommand(process.execPath, ['-e', input.script], input.directory,
      undefined, { expectedAgentId: input.owner, beforeSpawn: async () => ({ agentId: input.owner,
        variables: { FOREMAN_CODE_MCP_TOKEN: input.token } }) }, { recovery: input.recovery }))
  })
  it('denies an independently launched restricted MCP client with Authorization omitted', async () => {
    await nativeHttpIsolation(input => runCommand(process.execPath, ['-e', input.script], input.directory,
      undefined, { expectedAgentId: input.owner, beforeSpawn: async () => ({ agentId: input.owner,
        variables: { FOREMAN_CODE_MCP_TOKEN: input.token } }) }))
  })
})
