import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  SkillCreateInputSchema,
  SkillMutationResultSchema,
  type SkillVersion,
  type SkillVersionSummarySchema,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'

export const skillCollectionRoute = '/api/management/workspaces/:workspaceId/skills'
export const skillRoute = `${skillCollectionRoute}/:skillId`
export const skillListPath = '/api/management/skills'

export function instructionHash(instructions: string): string {
  return `sha256:${createHash('sha256').update(instructions, 'utf8').digest('hex')}`
}

export function skillVersionSummary(version: SkillVersion): ReturnType<typeof SkillVersionSummarySchema.parse> {
  return {
    workspaceId: version.workspaceId, skillId: version.skillId, version: version.version,
    name: version.name, contentHash: version.contentHash, createdAt: version.createdAt,
    ...(version.description === undefined ? {} : { description: version.description }),
  }
}

export async function createSkill(ctx: ScenarioContext, workspaceId: string, name: string) {
  const input = SkillCreateInputSchema.parse({
    workspaceId, commandId: randomUUID(), name, description: 'Conformance skill description.',
    instructions: 'Literal skill instructions.\nPreserve Unicode: λ ✓\n  ',
  })
  const path = `/api/management/workspaces/${workspaceId}/skills`
  const response = await ctx.http.request('POST', path, { body: input })
  const created = SkillMutationResultSchema.parse(response.body).value
  const contentHash = instructionHash(input.instructions)
  const common = { workspaceId, skillId: '<id>', name, description: input.description, version: '1', contentHash }
  assertResponse(response, {
    status: 201,
    body: {
      value: {
        skill: { ...common, revision: 1, versionCount: 1, archived: false,
          createdAt: '<timestamp>', updatedAt: '<timestamp>' },
        version: { ...common, instructions: input.instructions, createdAt: '<timestamp>' },
        changed: true,
      },
      replayed: false,
    },
  }, [
    { pointer: '/body/value/skill/skillId', kind: 'id' },
    { pointer: '/body/value/version/skillId', kind: 'id' },
    { pointer: '/body/value/skill/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/skill/updatedAt', kind: 'timestamp' },
    { pointer: '/body/value/version/createdAt', kind: 'timestamp' },
  ])
  assert.equal(created.skill.skillId, created.version.skillId)
  assert.equal(created.skill.createdAt, created.skill.updatedAt)
  return { input, created, path: `${path}/${created.skill.skillId}` }
}
