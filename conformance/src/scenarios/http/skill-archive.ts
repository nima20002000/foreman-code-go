import { randomUUID } from 'node:crypto'
import { SkillArchiveInputSchema, SkillMutationResultSchema } from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead } from './support.js'
import { createSkill, skillListPath, skillRoute } from './skill-support.js'

export const skillArchiveScenario: Scenario = {
  id: 'http.skills.archive-restore',
  title: 'Skill archive hides discovery while preserving historical versions and revision checks',
  lane: 'A2',
  covers: [
    httpCoverage('PUT', `${skillRoute}/archive`, 'success'),
    httpCoverage('PUT', `${skillRoute}/archive`, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Skill archive workspace')
    const workspaceId = workspace.created.workspace.id
    const { input: original, created, path } = await createSkill(ctx, workspaceId, 'Archived skill')
    const listing = `${skillListPath}?workspaceId=${encodeURIComponent(workspaceId)}`
    const archive = SkillArchiveInputSchema.parse({
      workspaceId, skillId: created.skill.skillId, commandId: randomUUID(), expectedRevision: 1, archived: true,
    })
    const response = await ctx.http.request('PUT', `${path}/archive`, { body: archive })
    const archived = SkillMutationResultSchema.parse(response.body).value
    assertResponse(response, {
      status: 200, body: { value: { ...created,
        skill: { ...created.skill, archived: true, revision: 2, updatedAt: '<timestamp>' }, changed: true,
      }, replayed: false },
    }, [{ pointer: '/body/value/skill/updatedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('PUT', `${path}/archive`, { body: archive }), {
      status: 200, body: { value: archived, replayed: true },
    })
    assertApiError(await ctx.http.request('PUT', `${path}/archive`, {
      body: { ...archive, commandId: randomUUID() },
    }), 409, 'SKILL_REVISION_CONFLICT',
    'This skill changed since you opened it. Review the latest version before saving.', { currentRevision: 2 })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...original, skillId: created.skill.skillId, commandId: randomUUID(), expectedRevision: 2 },
    }), 409, 'SKILL_ARCHIVED', 'Restore this archived skill before editing it.')
    await assertProtectedRead(ctx, path, { skill: archived.skill, version: created.version })
    await assertProtectedRead(ctx, listing, { items: [], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${listing}&includeArchived=true`, { items: [archived.skill], pageInfo: { nextCursor: null } })

    const restore = { ...archive, commandId: randomUUID(), expectedRevision: 2, archived: false }
    const restoredResponse = await ctx.http.request('PUT', `${path}/archive`, { body: restore })
    const restored = SkillMutationResultSchema.parse(restoredResponse.body).value
    assertResponse(restoredResponse, {
      status: 200, body: { value: { ...created,
        skill: { ...created.skill, revision: 3, updatedAt: '<timestamp>' }, changed: true,
      }, replayed: false },
    }, [{ pointer: '/body/value/skill/updatedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('PUT', `${path}/archive`, {
      body: { ...restore, commandId: randomUUID(), expectedRevision: 3 },
    }), { status: 200, body: { value: { ...restored, changed: false }, replayed: false } })
    await assertProtectedRead(ctx, listing, { items: [restored.skill], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${path}?version=1`, { skill: restored.skill, version: created.version })
  },
}
