import { randomUUID } from 'node:crypto'
import { SkillMutationResultSchema, SkillUpdateInputSchema } from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'
import {
  createSkill, instructionHash, skillCollectionRoute, skillListPath, skillRoute, skillVersionSummary,
} from './skill-support.js'

export const skillVersionScenario: Scenario = {
  id: 'http.skills.immutable-versions',
  title: 'Skill edits preserve exact text hashes, immutable versions, replay, and no-op revisions',
  lane: 'A2',
  covers: [
    ...readCoverage(skillListPath),
    ...readCoverage(skillRoute),
    ...readCoverage(`${skillRoute}/versions`),
    httpCoverage('POST', skillCollectionRoute, 'success'),
    httpCoverage('POST', skillCollectionRoute, 'error'),
    httpCoverage('PATCH', skillRoute, 'success'),
    httpCoverage('PATCH', skillRoute, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Skill versions workspace')
    const workspaceId = workspace.created.workspace.id
    const listing = `${skillListPath}?workspaceId=${encodeURIComponent(workspaceId)}`
    await assertProtectedRead(ctx, listing, { items: [], pageInfo: { nextCursor: null } })
    const { input, created, path } = await createSkill(ctx, workspaceId, 'Versioned skill')
    const collection = `/api/management/workspaces/${workspaceId}/skills`
    await assertProtectedRead(ctx, path, { skill: created.skill, version: created.version })
    assertResponse(await ctx.http.request('POST', collection, { body: input }), {
      status: 200, body: { value: created, replayed: true },
    })
    assertApiError(await ctx.http.request('POST', collection, {
      body: { ...input, name: 'Conflicting skill command' },
    }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')

    const update = SkillUpdateInputSchema.parse({
      ...input, commandId: randomUUID(), skillId: created.skill.skillId, expectedRevision: 1,
      name: 'Updated versioned skill', instructions: 'Updated literal instructions.\nKeep trailing whitespace:  \n',
    })
    const contentHash = instructionHash(update.instructions)
    const response = await ctx.http.request('PATCH', path, { body: update })
    const updated = SkillMutationResultSchema.parse(response.body).value
    assertResponse(response, {
      status: 200,
      body: {
        value: {
          skill: { ...created.skill, name: update.name, version: '2', contentHash,
            revision: 2, versionCount: 2, updatedAt: '<timestamp>' },
          version: { ...created.version, name: update.name, version: '2', contentHash,
            instructions: update.instructions, createdAt: '<timestamp>' },
          changed: true,
        },
        replayed: false,
      },
    }, [
      { pointer: '/body/value/skill/updatedAt', kind: 'timestamp' },
      { pointer: '/body/value/version/createdAt', kind: 'timestamp' },
    ])
    assertResponse(await ctx.http.request('PATCH', path, { body: update }), {
      status: 200, body: { value: updated, replayed: true },
    })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...update, commandId: randomUUID() },
    }), 409, 'SKILL_REVISION_CONFLICT',
    'This skill changed since you opened it. Review the latest version before saving.', { currentRevision: 2 })
    assertResponse(await ctx.http.request('PATCH', path, {
      body: { ...update, commandId: randomUUID(), expectedRevision: 2 },
    }), { status: 200, body: { value: { ...updated, changed: false }, replayed: false } })
    await assertProtectedRead(ctx, path, { skill: updated.skill, version: updated.version })
    await assertProtectedRead(ctx, `${path}?version=1`, { skill: updated.skill, version: created.version })
    await assertProtectedRead(ctx, `${path}/versions`, {
      items: [skillVersionSummary(updated.version), skillVersionSummary(created.version)], pageInfo: { nextCursor: null },
    })
    await assertProtectedRead(ctx, `${path}/versions?limit=1`, {
      items: [skillVersionSummary(updated.version)], pageInfo: { nextCursor: 'WzJd' },
    })
    await assertProtectedRead(ctx, `${path}/versions?limit=1&cursor=WzJd`, {
      items: [skillVersionSummary(created.version)], pageInfo: { nextCursor: null },
    })
    assertApiError(await ctx.http.request('GET', `${path}?version=missing`),
      404, 'SKILL_VERSION_NOT_FOUND', 'The skill version was not found.')
    await assertProtectedRead(ctx, `${listing}&query=Updated`, { items: [updated.skill], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${listing}&query=absent`, { items: [], pageInfo: { nextCursor: null } })
    await ctx.target.restart()
    await assertProtectedRead(ctx, `${path}?version=1`, { skill: updated.skill, version: created.version })
  },
}
