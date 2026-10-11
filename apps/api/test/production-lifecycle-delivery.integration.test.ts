import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { access, interactions, native, production, registerProductionLifecycleFixture, runs, runtime, start } from './helpers/productionLifecycleFixture.js'

registerProductionLifecycleFixture()

it('makes production Stop and native delivery progress with a one-slot pool', async () => {
  const { run, issuer, pending } = await start('user')

  const respond = vi.mocked(CodexAppServerSessionManager.prototype.respond)
  const original = respond.getMockImplementation()!
  let entered!: () => void, release!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  const permit = new Promise<void>((resolve) => { release = resolve })
  respond.mockImplementationOnce(async function (this: CodexAppServerSessionManager, ...args) {
    entered()
    await permit
    return original.apply(this, args)
  })
  const delivery = production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
    headers: {}, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
  // inject starts when awaited/then'ed; keep both requests live.
  const delivered = Promise.resolve(delivery)
  await writing
  const stopped = Promise.resolve(production.app.inject({ method: 'POST', url: `/api/management/workspaces/workspace-1/runs/${run.id}/stop`,
    headers: { authorization: `Bearer ${issuer.token}` }, payload: { commandId: randomUUID() } }))
  release()
  const [response, stop] = await Promise.all([delivered, stopped])
  // Stop may cancel the graph acknowledgement after the native receipt commits.
  expect([200, 409]).toContain(response.statusCode)
  if (response.statusCode === 409) expect(response.json().error.code).toBe('GRAPH_RESUME_OWNER_LOST')
  expect((await interactions.get(pending.id))?.deliveryState).toBe('delivered')
  expect(stop.statusCode, stop.body).toBe(200)
  expect(native.responses).toBe(1)
  expect((await runs.get(run.id))?.executionState).toBe('completed')
})

it('revalidates the accepting authority again between attachment and the native response', async () => {
  const { issuer, pending } = await start('user')

  const coordinator = runtime()
  const attach = coordinator.attachInteraction.bind(coordinator)
  vi.spyOn(coordinator, 'attachInteraction').mockImplementationOnce(async (...args) => {
    const attached = await attach(...args)
    await access.revoke(issuer.principal.id)
    return attached
  })
  const response = await production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
    headers: {}, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('failed')
  expect(native.responses).toBe(0)
})
