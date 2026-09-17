import { createHash } from 'node:crypto'
import type pg from 'pg'
import type { AssignedSkill, ResolvedSkill } from '@graphql/contracts'
import { SkillVersionSchema, type ManagementPrincipal, type SkillPublishInput } from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

export function skillHash(instructions: string): string {
  return `sha256:${createHash('sha256').update(instructions, 'utf8').digest('hex')}`
}

/** Catalog contents, not mutable pointers, are copied into an immutable execution snapshot. */
export async function resolveAssignedSkills(client: pg.ClientBase, workspaceId: string, references: readonly AssignedSkill[]): Promise<ResolvedSkill[]> {
  if (references.length > 100) throw new DomainError('SKILL_LIMIT_EXCEEDED', 'At most 100 skills can be assigned.', 400)
  const seen = new Set<string>()
  const resolved: ResolvedSkill[] = []
  for (const reference of references) {
    if (seen.has(reference.skillId)) throw new DomainError('SKILL_DUPLICATE', 'Assign only one version of each skill.', 400)
    seen.add(reference.skillId)
    const result = await client.query<{ record: unknown }>(
      'select record from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and version=$3',
      [workspaceId, reference.skillId, reference.version],
    )
    if (!result.rows[0]) throw new DomainError('SKILL_VERSION_NOT_FOUND', `Skill '${reference.skillId}@${reference.version}' is not in this workspace catalog. Publish it before assigning it.`, 409)
    const skill = SkillVersionSchema.parse(result.rows[0].record)
    if (skill.workspaceId !== workspaceId || skill.skillId !== reference.skillId || skill.version !== reference.version
      || skill.contentHash !== skillHash(skill.instructions)) throw new DomainError('SKILL_INTEGRITY_FAILED', 'The saved skill version failed its identity/integrity check.', 409)
    resolved.push({ skillId: skill.skillId, version: skill.version, instructions: skill.instructions, contentHash: skill.contentHash })
  }
  return resolved
}

export class SkillCatalogService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  async publish(principal: ManagementPrincipal, input: SkillPublishInput) {
    requireAuthorization(principal, 'skills:publish', { workspaceId: input.workspaceId })
    return this.commands.execute({ principal, source: 'mcp', operation: 'skill.publish', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:skill:${input.skillId}:${input.version}`, payload: input,
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const skill = SkillVersionSchema.parse({workspaceId: input.workspaceId, skillId: input.skillId, version: input.version,
          name: input.name, instructions: input.instructions, contentHash: skillHash(input.instructions), createdAt: new Date().toISOString()})
        const inserted = await client.query<{record: unknown}>(
          `insert into workspace_skill_versions(workspace_id,skill_id,version,record) values($1,$2,$3,$4::jsonb)
           on conflict do nothing returning record`, [input.workspaceId,input.skillId,input.version,JSON.stringify(skill)],
        )
        if (!inserted.rows[0]) throw new DomainError('SKILL_VERSION_EXISTS', 'Skill versions are immutable. Select a new version; retry the original command ID only for the same publish.', 409)
        return skill
      },
    })
  }

  async get(principal: ManagementPrincipal, input: {workspaceId: string; skillId: string; version: string}) {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    const rows = await this.pool.query<{record: unknown}>(
      'select record from workspace_skill_versions where workspace_id=$1 and skill_id=$2 and version=$3', [input.workspaceId,input.skillId,input.version],
    )
    if (!rows.rows[0]) throw new DomainError('SKILL_VERSION_NOT_FOUND', 'The skill version was not found.', 404)
    return {skill: SkillVersionSchema.parse(rows.rows[0].record)}
  }

  async list(principal: ManagementPrincipal, input: {workspaceId: string; limit: number; cursor?: string | undefined}) {
    requireAuthorization(principal, 'skills:read', { workspaceId: input.workspaceId })
    let after: [string, string] | null = null
    if (input.cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => typeof entry === 'string')) throw new Error()
        after = value as [string,string]
      } catch { throw new DomainError('CURSOR_INVALID', 'The skill cursor is invalid.', 400) }
    }
    const rows = await this.pool.query<{record: unknown}>(
      `select record from workspace_skill_versions where workspace_id=$1 and ($2::text is null or (skill_id,version)>($2,$3))
       order by skill_id,version limit $4`, [input.workspaceId,after?.[0] ?? null,after?.[1] ?? null,input.limit+1],
    )
    const items = rows.rows.slice(0,input.limit).map((row) => {
      const skill = SkillVersionSchema.parse(row.record)
      return {workspaceId: skill.workspaceId,skillId: skill.skillId,version: skill.version,name: skill.name,contentHash: skill.contentHash,createdAt: skill.createdAt}
    })
    const last = items.at(-1)
    return {items, pageInfo: {nextCursor: rows.rows.length > input.limit && last
      ? Buffer.from(JSON.stringify([last.skillId,last.version])).toString('base64url') : null}}
  }
}
