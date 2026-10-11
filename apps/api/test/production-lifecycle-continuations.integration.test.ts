import { expect, it } from 'vitest'
import { mkdir, rename } from 'node:fs/promises'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { access, interactions, native, production, project, registerProductionLifecycleFixture, runs, runtime, start } from './helpers/productionLifecycleFixture.js'

registerProductionLifecycleFixture()

for (const change of ['location', 'authority'] as const) it(`rejects a waiting continuation before inspection, attachment or delivery after ${change} changes`, async () => {
  const { run, issuer, pending } = await start('user')
  const before = { ...native }
  if (change === 'location') { await rename(project, `${project}-old`); await mkdir(project) }
  else await access.revoke(issuer.principal.id)
  try {
    await expect(runtime().attachInteraction(pending)).rejects.toMatchObject({ code: change === 'location' ? 'WORKSPACE_LOCATION_CHANGED' : 'RUN_AUTHORIZATION_REVOKED' })
    expect(native.inspections).toBe(before.inspections)
    expect(native.attaches).toBe(before.attaches)
    expect(native.responses).toBe(before.responses)
    expect((await runs.get(run.id))?.executionState).toBe('waiting')

    const response = await production.app.inject({ method: 'POST', url: `/api/user/interactions/${pending.id}/respond`,
      headers: {}, payload: { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision } })
    expect(response.statusCode).toBe(change === 'location' ? 409 : 403)
    const untouched = await interactions.get(pending.id)
    expect(untouched?.selectedOptionId).toBeUndefined()
    expect(untouched?.status).toBe('pending')
  } finally { if (change === 'location') { await removeFixtureDirectory(project, { force: false }); await rename(`${project}-old`, project) } }
})

