import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult, OperatorRunGetResultSchema } from '@foreman-code/contracts/operator-mcp'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { insertProviderRun } from './helpers/wave25Br1003Runtime.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

function result(raw: Parameters<typeof decodeMcpToolResult>[0]) {
  return OperatorRunGetResultSchema.parse(decodeMcpToolResult(raw))
}

describe.runIf(postgresEnabled)('Run isolation and authenticated MCP readback', () => {
  it('isolates concurrent Runs, recovers their persisted checkout and respects read grants', async () => {
    let service: RunWorktrees
    let runtimeRoot: string
    const f = await currentOperatorIntegration({ preparePlacementExecution: async (_owner, run, execution) => {
      const tree = await service.prepare(run)
      if (!tree) return undefined
      return { workingDirectory: tree.workingDirectory,
        runtimeDirectory: repeatRuntimeDirectory(runtimeRoot, { workspaceId: run.workspaceId, workflowId: run.workflowId,
          workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, execution),
        revalidate: () => service.verify(tree) }
    } })
    try {
      const environment = gitFixtureEnvironment()
      const ports = systemGitWorktreePorts(environment)
      const root = f.db.directory
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' }).trim()
      runtimeRoot = root
      service = new RunWorktrees(f.db.pool, join(root, 'managed-worktrees'), ports)
      const run = AcceptedWorkflowRunV3Schema.parse(f.f.run)
      // Ordinary directories still use the accepted workspace location.
      expect(await service.prepare(run)).toBeUndefined()
      git('init', '-b', 'main')
      await writeFile(join(root, 'project.txt'), 'default branch')
      git('add', 'project.txt')
      git('commit', '-m', 'Default')
      const baseCommit = git('rev-parse', 'HEAD')
      git('checkout', '-b', 'unrelated-feature')
      await writeFile(join(root, 'project.txt'), 'uncommitted workspace changes')
      const secondFixture = structuredClone(f.f)
      secondFixture.run.id = `run-${randomUUID()}`
      secondFixture.scope.runId = secondFixture.run.id
      await insertProviderRun(f.db.pool, secondFixture)
      const secondRun = AcceptedWorkflowRunV3Schema.parse(secondFixture.run)
      const [first, second] = await Promise.all([service.prepare(run), service.prepare(secondRun)])
      expect(first).toMatchObject({ baseCommit, state: 'active' })
      expect(second?.workingDirectory).not.toBe(first?.workingDirectory)
      expect(second?.branch).not.toBe(first?.branch)
      await writeFile(join(first!.workingDirectory, 'project.txt'), 'first Run edit')
      expect(await readFile(join(second!.workingDirectory, 'project.txt'), 'utf8')).toBe('default branch')
      expect(await readFile(join(root, 'project.txt'), 'utf8')).toBe('uncommitted workspace changes')
      expect(git('branch', '--show-current')).toBe('unrelated-feature')
      expect(await new RunWorktrees(f.db.pool, join(root, 'managed-worktrees'), ports).prepare(run)).toEqual(first)
      await Promise.all([f.engine.start(run.id), f.engine.start(secondRun.id)])
      await expect.poll(async () => (await f.runs.get(run.id))?.executionState, { timeout: 30000 }).toBe('waiting')
      await expect.poll(async () => (await f.runs.get(secondRun.id))?.executionState, { timeout: 30000 }).toBe('waiting')
      const args = { workspaceId: run.workspaceId, runId: run.id }
      expect(result(await f.client.callTool({ name: 'run_get', arguments: args }))).toMatchObject({ worktrees: [first] })
      const full = result(await f.client.callTool({ name: 'run_get', arguments: { ...args, detail: 'full' } }))
      expect(full).toMatchObject({ worktrees: [first], run: { executionLocation: run.executionLocation } })
      if ('detail' in full) throw new Error('Expected full Run details.')
      expect(full.executions.every(execution => execution.workingDirectory === first!.workingDirectory)).toBe(true)
      expect(f.dispatchErrors).toEqual([])
      const denied = await f.access.issue({ name: 'No Run reads', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [] })
      expect((await (await f.connect(denied.token)).callTool({ name: 'run_get', arguments: args })).isError).toBe(true)
      const reader = await f.access.issue({ name: 'Run reads without location', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:read'], scope: { workspaceIds: [run.workspaceId] } }] })
      expect(result(await (await f.connect(reader.token)).callTool({ name: 'run_get', arguments: args })))
        .not.toHaveProperty('worktrees')
    } finally { await f.close() }
  }, 60000)
})
