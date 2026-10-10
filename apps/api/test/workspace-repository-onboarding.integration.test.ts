import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagedWorkspaceCommandResultSchema, ManagedWorkspaceSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import {
  WorkspaceRepositoryAddResultSchema, WorkspaceRepositoryReadResultSchema, type WorkspaceRepositoryAddInput,
} from '@foreman-code/contracts/workspace-git'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../src/modules/errors.js'
import { REPOSITORY_ADD_ACTIONS, REPOSITORY_READ_ACTIONS } from '../src/modules/workspaces/repositoryService.js'
import { repositorySubcommand } from '../src/modules/workspaces/repositoryRecovery.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { fixtureGit, fixtureRepository, workspaceRepositoryFixture } from './helpers/workspaceRepository.js'

type Fixture = Awaited<ReturnType<typeof workspaceRepositoryFixture>>

async function workspace(f: Fixture): Promise<WorkspaceRepositoryAddInput> {
  const created = await callWorkspaceTool(f.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema,
    { commandId: randomUUID(), name: 'Git project' })
  return { workspaceId: created.value.workspace.id, commandId: randomUUID(), expectedRevision: created.value.revision,
    expectedLocationRevision: created.value.locationRevision, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
    repository: fixtureRepository, allowedBaseId: f.allowlist.bases[0]!.baseId,
    configurationRevision: f.allowlist.configurationRevision }
}

async function httpAdd(f: Fixture, input: WorkspaceRepositoryAddInput, token = f.owner.token) {
  return fetch(new URL(`/api/management/workspaces/${input.workspaceId}/repository`, f.address), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

const add = (f: Fixture, input: WorkspaceRepositoryAddInput) =>
  callWorkspaceTool(f.owner.client, 'workspace_repository_add', WorkspaceRepositoryAddResultSchema, input)
const get = (f: Fixture, input: { workspaceId: string; commandId?: string }) =>
  callWorkspaceTool(f.owner.client, 'workspace_repository_get', WorkspaceRepositoryReadResultSchema, input)
const clones = (f: Fixture) => f.gitCalls.filter(args => args.includes('clone')).length

describe('workspace repository onboarding', () => {
  it('prepares a raw tracked project in one HTTP call, replays through MCP, and reads fresh persisted state', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const previous = join(f.parentPath, 'manual-project')
      await mkdir(previous, { mode: 0o700 })
      await writeFile(join(previous, 'keep.txt'), 'keep the user project\n')
      const previousLocation = await f.services.locations.set(f.owner.principal, 'http', {
        workspaceId: input.workspaceId, commandId: randomUUID(), expectedLocationRevision: input.expectedLocationRevision,
        runnerId: f.services.locations.runnerId, rootPath: previous,
      })
      input.expectedLocationRevision = previousLocation.value.locationRevision
      const response = await httpAdd(f, input)
      expect(response.status).toBe(200)
      const saved = WorkspaceRepositoryAddResultSchema.parse(await response.json())
      expect(saved).toMatchObject({ replayed: false, value: { state: 'ready', repository: fixtureRepository,
        revision: input.expectedRevision + 1, operation: { phase: 'ready', commit: f.commit } } })
      const location = saved.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a bound project.')
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      expect(fixtureGit(location.executionLocation.rootPath, 'rev-parse', 'HEAD')).toBe(f.commit)
      expect(fixtureGit(location.executionLocation.rootPath, 'diff', '--exit-code')).toBe('')
      expect(saved.value.approvedSource!.manifest.entries.map(entry => entry.path)).toEqual([
        '.gitattributes', 'content.txt', 'run.sh',
      ])
      expect(saved.value.approvedSource!.manifest.entries.find(entry => entry.path === 'run.sh')!.executable).toBe(true)
      const pin = saved.value.approvedSource!.manifest
      const root = await callWorkspaceTool(f.owner.client, 'source_root_get', SourceRootRecordSchema,
        { workspaceId: input.workspaceId, ...saved.value.rootBinding! })
      expect(root.source).toEqual({ approvedSourceId: pin.approvedSourceId, snapshotId: pin.snapshotId,
        manifestDigest: pin.manifestDigest })
      expect(root.binding.accessMode).toBe('exclusive-write')
      expect(root.binding.canonicalPath).not.toBe(location.executionLocation.rootPath)
      expect(await add(f, input)).toEqual({ ...saved, replayed: true })
      expect(clones(f)).toBe(1)
      f.services.workspaceRepositories = f.recreate()
      expect(await get(f, { workspaceId: input.workspaceId })).toEqual(saved.value)
      expect(await f.recreate().get(f.owner.principal, 'http', { workspaceId: input.workspaceId })).toEqual(saved.value)
      expect(await readFile(join(previous, 'keep.txt'), 'utf8')).toBe('keep the user project\n')
      const audits = await f.pool.query<{ source: string; action: string }>(
        "select source,action from management_audit where target_key like $1 and outcome='succeeded'",
        [`%${input.workspaceId}%`])
      expect(audits.rows.some(row => row.action === 'workspace.repository.add' && row.source === 'http')).toBe(true)
      expect(audits.rows.filter(row => row.action === 'source.approve')).toEqual([
        { source: 'http', action: 'source.approve' },
      ])
    } finally {
      await f.close()
    }
  }, 30_000)

  it('requires all overlapping grants through authenticated MCP and HTTP before cloning', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const reader = await f.issue([{ actions: ['workspaces:read'], scope: { workspaceIds: [input.workspaceId] } }])
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_repository_add', arguments: input }))
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_repository_get', arguments: { workspaceId: input.workspaceId } }))
      expect((await httpAdd(f, input, reader.token)).status).toBe(403)
      const incomplete = await f.issue([{ actions: REPOSITORY_ADD_ACTIONS.filter(action => action !== 'sources:approve'),
        scope: { workspaceIds: [input.workspaceId] } }])
      expect((await incomplete.client.listTools()).tools.some(tool => tool.name === 'workspace_repository_add')).toBe(false)
      await expectMcpAccessDenied(incomplete.client.callTool({ name: 'workspace_repository_add', arguments: input }))
      expect((await httpAdd(f, input, incomplete.token)).status).toBe(403)
      const disjoint = await f.issue([
        { actions: REPOSITORY_ADD_ACTIONS.filter(action => action !== 'sources:approve'), scope: { workspaceIds: [input.workspaceId] } },
        { actions: ['sources:approve'], scope: { workspaceIds: ['other-workspace'] } },
      ])
      expect((await disjoint.client.listTools()).tools.some(tool => tool.name === 'workspace_repository_add')).toBe(false)
      expect((await httpAdd(f, input, disjoint.token)).status).toBe(403)
      const foreign = await f.issue([{ actions: [...REPOSITORY_ADD_ACTIONS], scope: { workspaceIds: ['other-workspace'] } }])
      await expectMcpAccessDenied(foreign.client.callTool({ name: 'workspace_repository_add', arguments: input }))
      expect((await httpAdd(f, input, foreign.token)).status).toBe(403)
      expect(clones(f)).toBe(0)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'unconfigured', revision: input.expectedRevision })
      const denied = await f.pool.query("select 1 from management_audit where outcome='denied' limit 1")
      expect(denied.rows).toHaveLength(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('rejects a preused derived subcommand ID instead of adopting an unrelated receipt', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const edited = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: repositorySubcommand(input, 'metadata'),
          expectedRevision: input.expectedRevision, name: 'Different operation' })
      input.expectedRevision = edited.value.revision
      const response = await httpAdd(f, input)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
      expect(clones(f)).toBe(0)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'COMMAND_ID_CONFLICT', newCommandRequired: true } } })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('recovers a committed location with a lost acknowledgment and keeps its original commit after branch advancement', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const set = f.roots.set.bind(f.roots)
      vi.spyOn(f.roots, 'set').mockImplementationOnce(async (...args) => {
        await set(...args)
        throw new Error('Location acknowledgment lost')
      })
      expect((await httpAdd(f, input)).status).toBe(500)
      const failed = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      expect(failed).toMatchObject({ state: 'failed', operation: { phase: 'metadata', commit: f.commit,
        failure: { retryable: true, newCommandRequired: false } } })
      await writeFile(join(f.origin, 'content.txt'), 'branch moved\n')
      fixtureGit(f.origin, 'commit', '-qam', 'advance branch')
      const fetches = f.gitCalls.filter(args => args.includes('fetch')).length
      f.services.workspaceRepositories = f.recreate()
      const saved = await add(f, input)
      expect(saved.value).toMatchObject({ state: 'ready', operation: { commit: f.commit },
        location: { locationRevision: input.expectedLocationRevision + 1 } })
      expect(saved.value.approvedSource!.manifest.git!.commit).toBe(f.commit)
      expect(clones(f)).toBe(1)
      expect(f.gitCalls.filter(args => args.includes('fetch'))).toHaveLength(fetches)
      const captures = await f.pool.query('select snapshot_id from source_approvals where workspace_id=$1', [input.workspaceId])
      expect(captures.rows).toHaveLength(1)
      expect(await add(f, input)).toEqual({ ...saved, replayed: true })
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('rejects stale revisions and changed input without replacing completed facts', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      for (const changed of [
        { expectedRevision: input.expectedRevision + 1 }, { expectedLocationRevision: 1 },
        { expectedRootPolicyRevision: 1 }, { expectedBindingRevision: 1 },
      ]) {
        expect((await httpAdd(f, { ...input, ...changed, commandId: randomUUID() })).status).toBe(409)
      }
      expect(clones(f)).toBe(0)
      const saved = await add(f, input)
      const conflict = await f.owner.client.callTool({ name: 'workspace_repository_add', arguments: {
        ...input, repository: { ...fixtureRepository, defaultBranch: 'other' },
      } })
      expect(conflict).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('COMMAND_ID_CONFLICT') }] })
      expect(await get(f, { workspaceId: input.workspaceId })).toEqual(saved.value)
      expect(clones(f)).toBe(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('recovers the fetched commit when resolution was interrupted before the journal recorded it', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const git = f.sources.git.git.bind(f.sources.git)
      let interrupted = false
      f.sources.git.git = async (args, options) => {
        const result = await git(args, options)
        if (args.includes('fetch') && !interrupted) {
          interrupted = true
          throw new Error('Interrupted after fetch wrote its recovery reference')
        }
        return result
      }
      expect((await httpAdd(f, input)).status).toBe(500)
      await writeFile(join(f.origin, 'content.txt'), 'a later branch commit\n')
      fixtureGit(f.origin, 'commit', '-qam', 'advance after interruption')
      const fetched = f.gitCalls.filter(args => args.includes('fetch')).length
      f.services.workspaceRepositories = f.recreate()
      const saved = await add(f, input)
      expect(saved.value).toMatchObject({ state: 'ready', operation: { commit: f.commit } })
      expect(saved.value.approvedSource!.manifest.git!.commit).toBe(f.commit)
      expect(f.gitCalls.filter(args => args.includes('fetch'))).toHaveLength(fetched)
      expect(clones(f)).toBe(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('rejects a substituted published clone origin on retry and preserves its files', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(new Error('Capture interrupted before approval'))
      expect((await httpAdd(f, input)).status).toBe(500)
      const partial = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      const location = partial.location!
      if (location.evidence !== 'bound') throw new Error('Expected a published project.')
      fixtureGit(location.executionLocation.rootPath, 'config', '--local', 'remote.origin.url', 'https://github.com/other/site.git')
      const fetched = f.gitCalls.filter(args => args.includes('fetch')).length
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'REPOSITORY_ORIGIN_CHANGED', newCommandRequired: true } } })
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      expect(f.gitCalls.filter(args => args.includes('fetch'))).toHaveLength(fetched)
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('reports unsupported trees and a missing branch without publishing metadata or a root', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const missing = { ...input, repository: { ...fixtureRepository, defaultBranch: 'missing' } }
      expect((await httpAdd(f, missing)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_REPOSITORY_BRANCH_NOT_FOUND', newCommandRequired: true, retryable: false } } })
      expect((await httpAdd(f, missing)).status).toBe(409)
      const prepared = await add(f, { ...input, commandId: randomUUID() })
      expect(prepared.value.state).toBe('ready')
      await symlink('content.txt', join(f.origin, 'link.txt'))
      fixtureGit(f.origin, 'add', '.')
      fixtureGit(f.origin, 'commit', '-qm', 'unsupported tree')
      const current = await callWorkspaceTool(f.owner.client, 'workspace_get', ManagedWorkspaceSchema, { workspaceId: input.workspaceId })
      const location = prepared.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a root policy.')
      const unsupported = { ...input, commandId: randomUUID(), expectedRevision: current.revision,
        expectedLocationRevision: location.locationRevision, expectedRootPolicyRevision: Number(location.binding.rootPolicyRevision),
        expectedBindingRevision: prepared.value.rootBinding!.bindingRevision }
      expect((await httpAdd(f, unsupported)).status).toBe(400)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: unsupported.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_GIT_TREE_UNSUPPORTED', newCommandRequired: true, retryable: false } } })
      expect((await callWorkspaceTool(f.owner.client, 'workspace_get', ManagedWorkspaceSchema,
        { workspaceId: input.workspaceId })).revision).toBe(current.revision)
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      expect((await httpAdd(f, unsupported)).status).toBe(409)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('serializes different commands for one workspace while Git is outside row-locking transactions', async () => {
    const f = await workspaceRepositoryFixture()
    let release!: () => void
    try {
      const input = await workspace(f)
      let reached!: () => void
      const fetching = new Promise<void>(resolve => { reached = resolve })
      const pause = new Promise<void>(resolve => { release = resolve })
      const git = f.sources.git.git.bind(f.sources.git)
      f.sources.git.git = async (args, options) => {
        if (args.includes('fetch')) {
          reached()
          await pause
        }
        return git(args, options)
      }
      const first = add(f, input)
      await fetching
      expect((await httpAdd(f, { ...input, commandId: randomUUID() })).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'preparing' })
      const edited = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: randomUUID(), expectedRevision: input.expectedRevision, name: 'Concurrent edit' })
      expect(edited.value.revision).toBe(input.expectedRevision + 1)
      release()
      await expect(first).rejects.toThrow('REVISION_CONFLICT')
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { newCommandRequired: true } } })
    } finally {
      release?.()
      await f.close()
    }
  }, 30_000)

  it('rechecks revoked grants between phases and resumes the same journal after grants are restored', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const update = f.services.workspaces.update.bind(f.services.workspaces)
      vi.spyOn(f.services.workspaces, 'update').mockImplementationOnce(async (...args) => {
        const saved = await update(...args)
        await f.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.owner.principal.id,
          JSON.stringify([{ actions: REPOSITORY_ADD_ACTIONS.filter(action => action !== 'sources:approve'), scope: {} }])])
        return saved
      })
      expect((await httpAdd(f, input)).status).toBe(403)
      const failed = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      expect(failed).toMatchObject({ state: 'failed', operation: { phase: 'metadata', failure: { code: 'ACCESS_DENIED' } } })
      await f.pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [f.owner.principal.id, JSON.stringify([{ actions: [...ManagementActionSchema.options], scope: {} }])])
      expect((await add(f, input)).value.state).toBe('ready')
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('requires a new attempt after a quarantined source capture failure', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(new DomainError('SOURCE_CAPTURE_FAILED',
        'This source capture failed. Start a new import.', 409, { newCommandRequired: true }))
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { phase: 'location', failure: { newCommandRequired: true, retryable: false } } })
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('shows unfinished replacement progress after reload and gives retry input only to its initiating principal', async () => {
    const f = await workspaceRepositoryFixture()
    let release!: () => void
    try {
      const input = await workspace(f)
      const previous = await add(f, input)
      const location = previous.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected the previous project root.')
      const replacement = { ...input, commandId: randomUUID(), expectedRevision: previous.value.revision,
        expectedLocationRevision: location.locationRevision, expectedRootPolicyRevision: Number(location.binding.rootPolicyRevision),
        expectedBindingRevision: previous.value.rootBinding!.bindingRevision }
      let reached!: () => void
      const fetching = new Promise<void>(resolve => { reached = resolve })
      const pause = new Promise<void>(resolve => { release = resolve })
      const git = f.sources.git.git.bind(f.sources.git)
      f.sources.git.git = async (args, options) => {
        if (args.includes('fetch')) {
          reached()
          await pause
        }
        return git(args, options)
      }
      vi.spyOn(f.services.workspaces, 'update').mockRejectedValueOnce(new Error('Replacement update interrupted'))
      const pending = httpAdd(f, replacement)
      await fetching
      f.services.workspaceRepositories = f.recreate()
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'preparing',
        operation: { commandId: replacement.commandId, retryInput: replacement } })
      const other = await f.issue([{ actions: [...REPOSITORY_READ_ACTIONS], scope: { workspaceIds: [input.workspaceId] } }])
      const progress = await callWorkspaceTool(other.client, 'workspace_repository_get', WorkspaceRepositoryReadResultSchema,
        { workspaceId: input.workspaceId })
      expect(progress).toMatchObject({ state: 'preparing', operation: { commandId: replacement.commandId } })
      expect(progress.operation?.retryInput).toBeUndefined()
      release()
      expect((await pending).status).toBe(500)
      f.services.workspaceRepositories = f.recreate()
      const failure = await get(f, { workspaceId: input.workspaceId })
      expect(failure).toMatchObject({ state: 'failed', operation: { commandId: replacement.commandId,
        retryInput: replacement, failure: { code: 'INTERNAL_ERROR', retryable: true } } })
      const sql = await f.pool.connect()
      try {
        await sql.query('begin')
        expect(await f.services.workspaceRepositories.readyRoot(f.owner.principal, input.workspaceId, sql))
          .toEqual(previous.value.rootBinding)
        await sql.query('commit')
      } finally {
        await sql.query('rollback')
        sql.release()
      }
      const resumed = await add(f, failure.operation!.retryInput!)
      expect(resumed.value.state).toBe('ready')
      expect(resumed.value.operation!.commandId).toBe(replacement.commandId)
      expect(resumed.value.operation!.retryInput).toEqual(replacement)
    } finally {
      release?.()
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('persists a numeric process exit as a string failure and supports the same-command retry', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const processError = Object.assign(new Error('Git inspection exited unsuccessfully'), { code: 128 })
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(processError)
      expect((await httpAdd(f, input)).status).toBe(500)
      f.services.workspaceRepositories = f.recreate()
      const failed = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      expect(failed).toMatchObject({ state: 'failed', operation: { retryInput: input,
        failure: { code: 'INTERNAL_ERROR', message: processError.message, retryable: true, newCommandRequired: false } } })
      expect((await add(f, input)).value.state).toBe('ready')
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('treats a missing Git origin as a persisted repository conflict', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(new Error('Capture interrupted before approval'))
      expect((await httpAdd(f, input)).status).toBe(500)
      const partial = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      const location = partial.location!
      if (location.evidence !== 'bound') throw new Error('Expected a published project.')
      fixtureGit(location.executionLocation.rootPath, 'config', '--local', '--unset-all', 'remote.origin.url')
      expect((await httpAdd(f, input)).status).toBe(409)
      f.services.workspaceRepositories = f.recreate()
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'REPOSITORY_ORIGIN_CHANGED', newCommandRequired: true, retryable: false } } })
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('keeps transport failures retryable and releases unsupported content for a corrected new import', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const git = f.sources.git.git.bind(f.sources.git)
      let offline = true
      f.sources.git.git = (args, options) => offline && (args.includes('fetch') || args.includes('ls-remote'))
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'Authentication or transport unavailable' })
        : git(args, options)
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_REPOSITORY_UNAVAILABLE', retryable: true, newCommandRequired: false } } })
      offline = false
      const previous = await add(f, input)
      fixtureGit(f.origin, 'branch', 'supported')
      await writeFile(join(f.origin, 'blocked.txt'), '-----BEGIN RSA PRIVATE KEY-----\nfixture bytes\n')
      fixtureGit(f.origin, 'add', '.')
      fixtureGit(f.origin, 'commit', '-qm', 'unsupported content')
      const location = previous.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a prepared root.')
      const replacement = { ...input, commandId: randomUUID(), expectedRevision: previous.value.revision,
        expectedLocationRevision: location.locationRevision, expectedRootPolicyRevision: Number(location.binding.rootPolicyRevision),
        expectedBindingRevision: previous.value.rootBinding!.bindingRevision }
      expect((await httpAdd(f, replacement)).status).toBe(400)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_SECRET_CONTENT', newCommandRequired: true, retryable: false } } })
      const corrected = await add(f, { ...replacement, commandId: randomUUID(),
        repository: { ...fixtureRepository, defaultBranch: 'supported' } })
      expect(corrected.value.state).toBe('ready')
      expect(corrected.value.approvedSource!.manifest.entries.map(entry => entry.path)).not.toContain('blocked.txt')
    } finally {
      await f.close()
    }
  }, 30_000)

  it('invalidates ready readback after unlinking metadata and preserves the clone and approved snapshot', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const saved = await add(f, input)
      const renamed = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision, name: 'Renamed project' })
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'ready', revision: renamed.value.revision })
      await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: randomUUID(), expectedRevision: renamed.value.revision, repository: null })
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'conflict', repository: null })
      expect((await add(f, input)).value.state).toBe('conflict')
      const location = saved.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a project root.')
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      const pin = saved.value.approvedSource!.manifest
      expect(await callWorkspaceTool(f.owner.client, 'source_get', ApprovedSourceSchema,
        { workspaceId: input.workspaceId, approvedSourceId: pin.approvedSourceId,
          snapshotId: pin.snapshotId, manifestDigest: pin.manifestDigest })).toEqual(saved.value.approvedSource)
    } finally {
      await f.close()
    }
  }, 30_000)
})
