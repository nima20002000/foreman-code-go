import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { deferred } from './helpers/deferred.js'
import { observe, lockWaiter, qualifyConfiguration } from './helpers/concurrentMutations.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it('keeps the application Operator consistent after overlapping defaults saves without revisions', async () => {
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const releaseSecond = deferred()
  let secondEntered = false
  const f = await workspaceMcpFixture({ configureServices: async ({ services, pool, commands }) => {
    services.settings = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool), commands,
      { qualifyConfiguration: async configuration => {
        if (configuration.model === 'operator-edited') {
          firstEntered.resolve()
          await releaseFirst.promise
        }
        if (configuration.model === 'coder-edited') {
          secondEntered = true
          await releaseSecond.promise
        }
        return qualifyConfiguration(configuration)
      } }, new PostgresOperatorRepository(pool))
  } })
  let first: ReturnType<typeof f.owner.client.callTool> | undefined
  let second: ReturnType<typeof f.owner.client.callTool> | undefined
  try {
    const operators = new PostgresOperatorRepository(f.pool)
    await operators.ensure()
    const original = await f.services.settings!.getAgentDefaults(f.owner.principal)
    const a = structuredClone(original.value)
    a.operator.harness.model = 'operator-edited'
    const b = structuredClone(original.value)
    b.coder.harness.model = 'coder-edited'
    const reader = await f.issue([{ actions: ['settings:read'], scope: {} }])
    await expectMcpAccessDenied(reader.client.callTool({ name: 'agent_defaults_update',
      arguments: { commandId: randomUUID(), value: a } }))
    first = f.owner.client.callTool({ name: 'agent_defaults_update', arguments: { commandId: randomUUID(), value: a } })
    await firstEntered.promise
    second = f.owner.client.callTool({ name: 'agent_defaults_update', arguments: { commandId: randomUUID(), value: b } })
    await observe(async () => secondEntered || await lockWaiter(f.pool, 'setting:agent-defaults-v1'))
    releaseFirst.resolve()
    expect((await first).isError).not.toBe(true)
    releaseSecond.resolve()
    expect((await second).isError).not.toBe(true)
    const persisted = await new PostgresFoundationSettingsRepository(f.pool).getAgentDefaults()
    expect(persisted.value.coder.harness.model).toBe('coder-edited')
    expect(persisted.value.operator.harness.model).toBe(original.value.operator.harness.model)
    expect((await operators.ensure()).configuration.harness).toEqual(persisted.value.operator.harness)
    expect(decodeMcpToolResult(await reader.client.callTool({ name: 'agent_defaults_get', arguments: {} })))
      .toEqual(persisted)
  } finally {
    releaseFirst.resolve()
    releaseSecond.resolve()
    await Promise.allSettled([first, second])
    await f.close()
  }
})
