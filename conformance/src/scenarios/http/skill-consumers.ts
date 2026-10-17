import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ResolvedSkill } from '@foreman-code/contracts'
import {
  ManagedAgentDetailSchema,
  SkillMutationResultSchema,
  SkillUpdateInputSchema,
  SkillUsersUpdateInputSchema,
  SkillUsersUpdateResultSchema,
  type SkillVersion,
} from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { createCodexAgent } from '../workflows/support.js'
import { codexConfigurationVersion, updateUnreferencedAgent } from './agent-support.js'
import { createSkill, instructionHash, skillRoute } from './skill-support.js'
import { assertProtectedRead, readCoverage } from './support.js'

function skillSnapshot(version: SkillVersion): ResolvedSkill {
  return { skillId: version.skillId, version: version.version, name: version.name,
    instructions: version.instructions, contentHash: version.contentHash }
}

async function reviseInstructions(ctx: ScenarioContext, fixture: Awaited<ReturnType<typeof createSkill>>) {
  const { input: original, created, path } = fixture
  const input = SkillUpdateInputSchema.parse({
    ...original, skillId: created.skill.skillId, commandId: randomUUID(), expectedRevision: 1,
    instructions: 'Use the newly published skill instructions.\nPreserve the exact accepted version.\n',
  })
  const response = await ctx.http.request('PATCH', path, { body: input })
  const updated = SkillMutationResultSchema.parse(response.body).value
  const contentHash = instructionHash(input.instructions)
  assertResponse(response, {
    status: 200,
    body: { value: {
      skill: { ...created.skill, version: '2', contentHash, revision: 2, versionCount: 2, updatedAt: '<timestamp>' },
      version: { ...created.version, version: '2', contentHash, instructions: input.instructions, createdAt: '<timestamp>' },
      changed: true,
    }, replayed: false },
  }, [
    { pointer: '/body/value/skill/updatedAt', kind: 'timestamp' },
    { pointer: '/body/value/version/createdAt', kind: 'timestamp' },
  ])
  return updated
}

export const skillConsumerScenario: Scenario = {
  id: 'http.skills.update-consumers',
  title: 'Skill consumer updates publish a real Agent configuration and preserve the older pinned snapshot',
  lane: 'A2',
  covers: [
    ...readCoverage(`${skillRoute}/usage`),
    httpCoverage('POST', `${skillRoute}/update-users`, 'success'),
    httpCoverage('POST', `${skillRoute}/update-users`, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Skill consumer workspace')
    const workspaceId = workspace.created.workspace.id
    const skill = await createSkill(ctx, workspaceId, 'Assigned versioned skill')
    const createdAgent = await createCodexAgent(ctx, workspaceId, { name: 'Skill consumer coder' })
    const pinned = await updateUnreferencedAgent(ctx, workspaceId, createdAgent, {
      assignedSkills: [{ skillId: skill.created.skill.skillId, version: '1' }],
    })
    assert.ok(pinned.updated.agent.updatedAt)
    const oldConfiguration = codexConfigurationVersion(workspaceId, pinned.updated.agent, 2,
      pinned.updated.agent.updatedAt, [skillSnapshot(skill.created.version)])
    const agentPath = `/api/management/workspaces/${workspaceId}/agents/${createdAgent.agent.id}`
    await assertProtectedRead(ctx, `${agentPath}/versions/${oldConfiguration.id}`, { version: oldConfiguration })
    const updatedSkill = await reviseInstructions(ctx, skill)
    await assertProtectedRead(ctx, `${skill.path}/usage`, {
      skillId: skill.created.skill.skillId, headVersion: '2',
      agents: [{ agentId: createdAgent.agent.id, name: createdAgent.agent.name, version: '1' }], workflows: [],
    })
    const input = SkillUsersUpdateInputSchema.parse({
      workspaceId, skillId: skill.created.skill.skillId, commandId: randomUUID(),
    })
    const response = await ctx.http.request('POST', `${skill.path}/update-users`, { body: input })
    const result = SkillUsersUpdateResultSchema.parse(response.body)
    assertResponse(response, {
      status: 200, body: { headVersion: '2',
        agents: [{ agentId: createdAgent.agent.id, configurationVersionId: '<id>' }], workflows: [], failed: [] },
    }, [{ pointer: '/body/agents/0/configurationVersionId', kind: 'id' }])
    const configurationVersionId = result.agents[0]!.configurationVersionId
    assert.notEqual(configurationVersionId, oldConfiguration.id)
    const read = await ctx.http.request('GET', agentPath)
    const current = ManagedAgentDetailSchema.parse(read.body)
    assertResponse(read, {
      status: 200,
      body: { agent: { ...pinned.updated.agent, configurationVersionId,
        assignedSkills: [{ skillId: skill.created.skill.skillId, version: '2' }], updatedAt: '<timestamp>' },
      metadataRevision: 3, archivedAt: null, workflowIds: [] },
    }, [{ pointer: '/body/agent/updatedAt', kind: 'timestamp' }])
    assert.ok(current.agent.updatedAt)
    const newConfiguration = codexConfigurationVersion(workspaceId, current.agent, 3,
      current.agent.updatedAt, [skillSnapshot(updatedSkill.version)])
    await assertProtectedRead(ctx, `${agentPath}/versions/${newConfiguration.id}`, { version: newConfiguration })
    await assertProtectedRead(ctx, `${agentPath}/versions/${oldConfiguration.id}`, { version: oldConfiguration })
    await assertProtectedRead(ctx, `${skill.path}/usage`, {
      skillId: skill.created.skill.skillId, headVersion: '2', agents: [], workflows: [],
    })
    assertResponse(await ctx.http.request('POST', `${skill.path}/update-users`, { body: input }), {
      status: 200, body: result,
    })
    assertResponse(await ctx.http.request('POST', `${skill.path}/update-users`, {
      body: { ...input, commandId: randomUUID() },
    }), { status: 200, body: { headVersion: '2', agents: [], workflows: [], failed: [] } })
    const missingPath = `/api/management/workspaces/${workspaceId}/skills/skill-missing/update-users`
    assertApiError(await ctx.http.request('POST', missingPath, {
      body: { ...input, skillId: 'skill-missing', commandId: randomUUID() },
    }), 404, 'SKILL_NOT_FOUND', 'The skill was not found in this workspace.')
    await ctx.target.restart()
    await assertProtectedRead(ctx, agentPath, current)
    await assertProtectedRead(ctx, `${agentPath}/versions/${oldConfiguration.id}`, { version: oldConfiguration })
  },
}
