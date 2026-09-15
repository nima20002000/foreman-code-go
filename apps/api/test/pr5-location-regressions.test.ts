import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_HARNESS_DEFAULTS,
  HarnessExecutionRequestSchema,
  HarnessQualificationSchema,
} from '@graphql/contracts'
import { ManagedWorkspaceCommandResultSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { commandInputHash, PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CodexAdapter } from '../src/modules/harnesses/codex.js'
import { OpenCodeAdapter } from '../src/modules/harnesses/opencode.js'
import { pathsOverlap, canonicalRuntimePath, withFilesystemDeadline } from '../src/modules/workspaces/filesystem.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { replayWorkspaceResult } from '../src/modules/workspaces/receipts.js'

const principal: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['workspaces:create'], scope: {} }],
}
const legacy = { workspace: { id: 'workspace-a', name: 'A' }, revision: 1, archivedAt: null }
const posix = process.platform === 'win32' ? it.skip : it

function request(harness: 'codex' | 'opencode', workingDirectory: string) {
  return HarnessExecutionRequestSchema.parse({
    executionId: 'execution', runId: 'run', workspaceId: 'workspace-a', workflowNodeId: 'node',
    workingDirectory, runtimeDirectory: `${workingDirectory}-runtime `, input: {},
    configuration: {
      id: 'configuration', workspaceId: 'workspace-a', agentId: 'agent', version: 1,
      prompt: {}, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS[harness],
      contentHash: 'fixture', createdAt: new Date().toISOString(),
    },
  })
}

function qualification(harness: 'codex' | 'opencode') {
  return HarnessQualificationSchema.parse({
    harness, version: 'fixture', authenticated: true, ready: true, structuredEvents: true,
    supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
  })
}

async function nativeFixture(root: string): Promise<string> {
  const binary = join(root, 'fixture-native')
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync('launched', process.cwd());
  const text = fs.readFileSync('marker', 'utf8');
  const codex = process.argv[2] === 'exec';
  console.log(JSON.stringify(codex ? {type:'thread.started',thread_id:'session'} : {type:'start',sessionID:'session'}));
  console.log(JSON.stringify(codex ? {type:'item.completed',item:{type:'agent_message',text}} : {type:'text',part:{text}}));
});\n`, { mode: 0o755 })
  return binary
}

describe('PR #5 runner locations', () => {
  it('preserves both accepted launch paths byte-for-byte and rejects NUL', () => {
    const parsed = request('codex', '/projects/project ')
    expect(parsed.workingDirectory).toBe('/projects/project ')
    expect(parsed.runtimeDirectory).toBe('/projects/project -runtime ')
    expect(() => HarnessExecutionRequestSchema.parse({ ...parsed, workingDirectory: '/projects/a\0b' })).toThrow()
    expect(() => HarnessExecutionRequestSchema.parse({ ...parsed, runtimeDirectory: '' })).toThrow()
  })

  it('detects containment by path segments, not a two-dot name prefix', () => {
    const project = join(tmpdir(), 'project')
    expect(pathsOverlap(project, join(project, '..scratch'))).toBe(true)
    expect(pathsOverlap(join(project, 'child'), project)).toBe(true)
    expect(pathsOverlap(project, `${project}-sibling`)).toBe(false)
  })

  posix('canonicalizes aliases and missing descendants, but rejects dangling symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr5-canonical-'))
    try {
      const project = join(root, 'project')
      await mkdir(join(project, 'runtime'), { recursive: true })
      const alias = join(root, 'alias')
      await symlink(join(project, 'runtime'), alias, 'dir')
      for (const path of [alias, join(alias, 'not-created', 'yet')]) {
        expect(pathsOverlap(project, await withFilesystemDeadline((check) => canonicalRuntimePath(path, check)))).toBe(true)
      }
      await symlink(join(root, 'missing'), join(root, 'broken'), 'dir')
      await expect(withFilesystemDeadline((check) => canonicalRuntimePath(join(root, 'broken', 'child'), check))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('settles a stalled filesystem lookup on timeout without continuing after it resolves', async () => {
    let release!: () => void
    let continued = false
    const pending = new Promise<void>((resolve) => { release = resolve })
    await expect(withFilesystemDeadline(async (check) => {
      await check(() => pending)
      continued = true
    }, undefined, 15)).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_TIMEOUT' })
    release()
    await Promise.resolve()
    expect(continued).toBe(false)
  })

  it('settles immediately on Stop and observes a later rejected lookup', async () => {
    const controller = new AbortController()
    let rejectRead!: (error: Error) => void
    const pending = new Promise<void>((_resolve, reject) => { rejectRead = reject })
    const result = withFilesystemDeadline((check) => check(() => pending), controller.signal)
    const expected = expect(result).rejects.toThrow('Stop')
    controller.abort(new Error('Stop'))
    await expected
    rejectRead(new Error('Late filesystem rejection'))
    await Promise.resolve()
  })

  for (const source of ['http', 'mcp'] as const) {
    it(`replays a PR #4 workspace receipt for ${source} without running its mutation`, async () => {
      const payload = { commandId: 'legacy-command', name: 'A' }
      const perform = vi.fn(async () => { throw new Error('Receipt must not repeat mutation') })
      const client = {
        query: vi.fn(async (sql: string) => ({ rows: sql.includes('select input_hash')
          ? [{ input_hash: commandInputHash(payload), target_key: 'workspaces:new', result: legacy }] : [] })),
        release: vi.fn(),
      }
      const coordinator = new PostgresCommandCoordinator({ connect: async () => client } as unknown as pg.Pool)
      const result = await coordinator.execute({
        principal, source, operation: 'workspace.create', commandId: payload.commandId,
        targetKey: 'workspaces:new', payload, perform, replayResult: replayWorkspaceResult,
      })
      expect(ManagedWorkspaceCommandResultSchema.parse(result)).toEqual({ value: {
        ...legacy, executionLocation: null, locationRevision: 0, locationValidation: { status: 'restricted' },
      }, replayed: true })
      expect(perform).not.toHaveBeenCalled()
      expect(client.release).toHaveBeenCalledOnce()
      expect(legacy).not.toHaveProperty('executionLocation')
    })
  }

  it('adapts only complete legacy receipts, never malformed partial new results', () => {
    expect(() => replayWorkspaceResult({ ...legacy, locationRevision: 2 })).toThrow()
    expect(() => replayWorkspaceResult({ ...legacy, unexpected: true })).toThrow()
    const modern = replayWorkspaceResult(legacy)
    expect(replayWorkspaceResult(modern)).toEqual(modern)
  })

  it('audits a failed command on the same rolled-back client even when the pool has no spare capacity', async () => {
    const original = new Error('command failed')
    const sql: string[] = []
    const client = { query: vi.fn(async (query: string) => { sql.push(query); return { rows: [] } }), release: vi.fn() }
    const pool = { connect: async () => client, query: vi.fn(async () => { throw new Error('Nested connection') }) }
    const coordinator = new PostgresCommandCoordinator(pool as unknown as pg.Pool)
    await expect(coordinator.execute({ principal, source: 'http', operation: 'workspace.location.set',
      commandId: 'failed-command', targetKey: 'workspace:a', payload: {}, perform: async () => { throw original },
    })).rejects.toBe(original)
    expect(pool.query).not.toHaveBeenCalled()
    expect(sql.findIndex((query) => query.includes("'failed'"))).toBeGreaterThan(sql.indexOf('rollback'))
    expect(client.release).toHaveBeenCalledOnce()
  })

  for (const harness of ['codex', 'opencode'] as const) {
    for (const resume of [false, true]) {
      posix(`${harness} ${resume ? 'resume' : 'execute'} launches in the exact trailing-space directory`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'pr5-launch-'))
        try {
          const selected = join(root, 'project ')
          const sibling = join(root, 'project')
          await mkdir(selected)
          await mkdir(sibling)
          await writeFile(join(selected, 'marker'), 'SELECTED')
          await writeFile(join(sibling, 'marker'), 'UNSELECTED')
          const binary = await nativeFixture(root)
          const adapter = harness === 'codex' ? new CodexAdapter(binary) : new OpenCodeAdapter(binary)
          vi.spyOn(adapter, 'qualify').mockResolvedValue(qualification(harness))
          const callbacks = { signal: new AbortController().signal, onSession: async () => {}, onEvent: async () => {} }
          const parsed = request(harness, selected)
          const result = await (resume ? adapter.resume(parsed, 'session', callbacks) : adapter.execute(parsed, callbacks))
          expect(result.output).toEqual({ text: 'SELECTED' })
          expect(await readFile(join(selected, 'launched'), 'utf8')).toBe(selected)
          await expect(stat(join(sibling, 'launched'))).rejects.toMatchObject({ code: 'ENOENT' })
          // The same accepted path still works without the trimmed sibling.
          await rm(sibling, { recursive: true, force: true })
          await expect(adapter.execute(parsed, callbacks)).resolves.toMatchObject({ output: { text: 'SELECTED' } })
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      })

      posix(`${harness} ${resume ? 'resume' : 'execute'} rechecks replacement after qualification and before spawning`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'pr5-replacement-'))
        try {
          const selected = join(root, 'project')
          await mkdir(selected)
          const details = await stat(selected, { bigint: true })
          const snapshot = {
            runnerId: 'runner-local', rootPath: selected, locationRevision: 1,
            identityHash: `sha256:${createHash('sha256').update(`${details.dev}:${details.ino}`).digest('hex')}`,
          }
          const service = new WorkspaceLocationService({} as pg.Pool, {} as PostgresCommandCoordinator)
          await service.revalidateSnapshot('workspace-a', snapshot, 'read-only')
          const binary = await nativeFixture(root)
          const adapter = harness === 'codex' ? new CodexAdapter(binary) : new OpenCodeAdapter(binary)
          vi.spyOn(adapter, 'qualify').mockImplementation(async () => {
            await rename(selected, `${selected}-original`)
            await mkdir(selected)
            await writeFile(join(selected, 'marker'), 'REPLACEMENT')
            return qualification(harness)
          })
          const callbacks = {
            signal: new AbortController().signal, onSession: async () => {}, onEvent: async () => {},
            beforeSpawn: () => service.revalidateSnapshot('workspace-a', snapshot, 'read-only'),
          }
          await expect(resume ? adapter.resume(request(harness, selected), 'session', callbacks)
            : adapter.execute(request(harness, selected), callbacks)).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_CHANGED' })
          await expect(stat(join(selected, 'launched'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      })
    }
  }
})
