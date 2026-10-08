import Fastify from 'fastify'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { jobVerificationTemplate } from '@foreman-code/contracts/job-verification'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { DomainError } from '../src/modules/errors.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { ciFixture } from './helpers/ciFixture.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { snapshotAgentWorktree } from '../src/modules/sources/agentSnapshot.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'

async function fixture() {
  const data = ciFixture()
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
    .send({ error: 'Request denied.' }))
  const access = { authenticate: async (token: string) => {
    const principal = { worker: data.worker, operator: data.operator, readonly: data.readonly,
      foreign: { ...data.worker, id: 'foreign-agent' }, disabled: { ...data.worker, id: 'disabled-agent' } }[token]
    if (!principal) throw new DomainError('AUTH_INVALID', 'Invalid bearer token.', 401)
    return principal
  } } as unknown as PostgresAccessService
  const interactions = { toolAccess: async (principal: { id: string }) => ({ role: 'coder',
    tools: principal.id === 'disabled-agent' ? ['context_get'] : ['ci_run', 'ci_get'] }),
  canRead: async () => false, canRespond: async () => false } as unknown as AppInteractionService
  registerGraphqlMcp(app, { access, operator: data.services, interactions })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  let requestId = 0
  const request = async (method: string, params: unknown, token = 'worker') => {
    const response = await fetch(`${address}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) })
    const text = await response.text()
    const body = text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text
    return { status: response.status, ...JSON.parse(body) }
  }
  const call = (name: string, input: unknown, token = 'worker') =>
    request('tools/call', { name, arguments: input }, token)
  return { ...data, app, call, request }
}

describe('CI over the authenticated unified MCP transport', () => {
  it('lists Agent schemas with no workspace selector and Operator schemas with workspaceId', async () => {
    const f = await fixture()
    try {
      const workerTools = (await f.request('tools/list', {})).result.tools
      expect(workerTools.map((tool: { name: string }) => tool.name)).toEqual(['ci_run', 'ci_get'])
      expect(workerTools[0].inputSchema.properties).not.toHaveProperty('workspaceId')
      const operatorTools = (await f.request('tools/list', {}, 'operator')).result.tools
      expect(operatorTools.find((tool: { name: string }) => tool.name === 'ci_run').inputSchema.required)
        .toContain('workspaceId')
    } finally { await f.app.close() }
  })

  it('retries one command after HEAD advances and reads retained queue and published results after service recreation', async () => {
    const f = await fixture()
    try {
      const input = { suite: 'unit', commandId: 'ci-command' }
      const first = await f.call('ci_run', input)
      expect(first.result.isError).not.toBe(true)
      const started = CiRunOutputSchema.parse(first.result.structuredContent)
      f.advanceHead()
      f.services.ci = f.createCi()
      const retry = await f.call('ci_run', input)
      expect(CiRunOutputSchema.parse(retry.result.structuredContent)).toEqual(started)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 1 })
      const waiting = await f.call('ci_get', { ticketId: started.ticketId })
      expect(CiGetOutputSchema.parse(waiting.result.structuredContent)).toMatchObject({
        queue: { state: 'waiting', waitingReasons: ['busy'], principalId: 'accepted-run-principal',
          definition: { spec: { source: { commit: 'b'.repeat(40) }, target: { kind: 'auto' } } } }, process: null,
      })
      f.complete()
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId: started.ticketId })).result.structuredContent)
      expect(read).toMatchObject({ queue: { state: 'accepted', selectedComputer: { profileId: 'profile' } },
        process: { outcome: 'succeeded', exitCode: 0 }, publication: 'complete',
        summaryReport: { report: { outcome: 'passed', commit: 'b'.repeat(40), totals: { total: 3 } } },
        logTail: { text: 'tests passed\n', truncated: false } })
      expect(f.audits).toContainEqual({ principalId: f.worker.id, action: 'ci.run', outcome: 'succeeded' })
      expect(f.roots.map(root => root.binding.bindingRevision)).toEqual([2, 1])
      const changed = await f.call('ci_run', { ...input, commit: 'c'.repeat(40) })
      expect(JSON.stringify(changed.result)).toContain('COMMAND_ID_CONFLICT')
    } finally { await f.app.close() }
  })

  it('denies foreign workspace tickets, disabled Agent tools, readonly Operators and invalid credentials', async () => {
    const f = await fixture()
    try {
      const started = CiRunOutputSchema.parse((await f.call('ci_run', {
        suite: 'unit', commandId: 'ci-command', commit: 'c'.repeat(40),
      })).result.structuredContent)
      const foreign = await f.call('ci_get', { ticketId: started.ticketId }, 'foreign')
      expect(JSON.stringify(foreign.result)).toContain('ACCESS_DENIED')
      const disabled = await f.call('ci_run', { suite: 'unit', commandId: 'other-command' }, 'disabled')
      expect(JSON.stringify(disabled.result)).toContain('TOOL_NOT_ENABLED')
      expect(f.audits).toContainEqual({ principalId: 'disabled-agent', action: 'ci_run', outcome: 'denied' })
      const readonly = await f.call('ci_run', { workspaceId: f.workspaceId, suite: 'unit', commandId: 'reader-command' }, 'readonly')
      expect(JSON.stringify(readonly.result)).toContain('ACCESS_DENIED')
      const wrongWorkspace = await f.call('ci_get', { workspaceId: 'foreign-workspace', ticketId: started.ticketId }, 'operator')
      expect(JSON.stringify(wrongWorkspace.result)).toContain('ACCESS_DENIED')
      expect((await f.call('ci_run', {}, 'invalid')).status).toBe(401)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 1 })
    } finally { await f.app.close() }
  })

  it('refuses CI when no build computer can receive the commit', async () => {
    const f = await fixture()
    try {
      f.roots[0]!.offline = true
      const result = await f.call('ci_run', { suite: 'unit', commandId: 'all-offline' })
      expect(JSON.stringify(result.result)).toContain('CI_NO_BUILD_COMPUTER')
      expect(f.counts().enqueues).toBe(0)
    } finally { await f.app.close() }
  })

  it('tests an Agent\'s current files and tries its own computer first', async () => {
    const f = await fixture()
    try {
      f.agentExecution.id = 'execution-agent'
      const started = CiRunOutputSchema.parse((await f.call('ci_run', { suite: 'unit', commandId: 'agent-ci' })).result.structuredContent)
      expect(f.snapshotCalls).toEqual([{ hostRef: { kind: 'device', mainId: f.agent.mainId, deviceId: f.agent.deviceId },
        path: '/home/laptop/root/x/tree', baseCommit: 'b'.repeat(40) }])
      expect(f.approvals.at(-1)).toMatchObject({ snapshot: { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40) } })
      expect(f.enqueued.at(-1)).toMatchObject({ placementOverride: { kind: 'prefer',
        hostRef: { kind: 'device', mainId: f.agent.mainId, deviceId: f.agent.deviceId } } })
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId: started.ticketId })).result.structuredContent)
      expect(read.queue.definition.spec.source.commit).toBe('c'.repeat(40))
      // An explicit commit is tested as given, still preferring the Agent's computer.
      await f.call('ci_run', { suite: 'unit', commandId: 'agent-ci-commit', commit: 'd'.repeat(40) })
      expect(f.snapshotCalls).toHaveLength(1)
    } finally { await f.app.close() }
  })

  it('recovers the original snapshot after source approval commits but CI preparation fails', async () => {
    const f = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'ci-retry-snapshot-'))
    const git = systemGitWorktreePorts(gitFixtureEnvironment())
    const runGit = async (args: string[]) => {
      const result = await git.git(args, { cwd: root, signal: AbortSignal.timeout(30_000) })
      if (result.code !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    try {
      await runGit(['init', '-q', '-b', 'main'])
      await writeFile(join(root, 'app.ts'), 'base\n')
      await runGit(['add', '.'])
      await runGit(['commit', '-qm', 'base'])
      const baseCommit = await runGit(['rev-parse', 'HEAD'])
      await writeFile(join(root, 'app.ts'), 'uncommitted agent work\n')
      f.agentExecution.id = 'execution-agent'
      let date = '2000-01-01T00:00:00Z'
      const snapshots = vi.fn(async () => snapshotAgentWorktree(systemGitWorktreePorts({
        ...gitFixtureEnvironment(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      }), { path: root, baseCommit }, AbortSignal.timeout(30_000)))
      f.services.ci!.snapshots = snapshots
      vi.spyOn(f.jobs, 'choices').mockRejectedValueOnce(new Error('Preparation interrupted after source approval'))
      const input = { suite: 'unit', commandId: 'interrupted-ci' }
      expect((await f.call('ci_run', input)).result.isError).toBe(true)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 0 })
      const original = snapshots.mock.results[0]!
      const snapshot = await original.value
      date = '2000-01-02T00:00:00Z'
      await writeFile(join(root, 'app.ts'), 'later agent work\n')
      f.services.ci = f.createCi()
      f.services.ci.snapshots = snapshots
      const retry = await f.call('ci_run', input)
      expect(retry.result.isError, JSON.stringify(retry.result)).not.toBe(true)
      const started = CiRunOutputSchema.parse(retry.result.structuredContent)
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId: started.ticketId })).result.structuredContent)
      expect(read.queue.definition.spec.source.commit).toBe(snapshot.commit)
      expect(snapshots).toHaveBeenCalledTimes(1)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 1 })
      expect(CiRunOutputSchema.parse((await f.call('ci_run', input)).result.structuredContent)).toEqual(started)
      expect(f.counts().enqueues).toBe(1)
    } finally {
      await f.app.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['same source', 'different sources'])('reconciles parallel suites sharing one build root with %s', async kind => {
    const f = await fixture()
    try {
      f.roots.splice(1)
      const choices = await f.jobs.choices(f.operator, f.workspaceId, 'mcp')
      const unit = choices.verificationTemplates![0]!
      vi.spyOn(f.jobs, 'choices').mockResolvedValue({ ...choices, verificationTemplates: [unit,
        jobVerificationTemplate({ ...unit, suite: 'lint' })] })
      if (kind === 'same source') {
        const source = await f.sources.approveProject(f.operator, { workspaceId: f.workspaceId, commandId: 'shared-source' })
        vi.spyOn(f.sources, 'approveProject').mockResolvedValue(source)
      }
      const rootList = f.sources.rootList.bind(f.sources)
      let bothRead!: () => void
      const reads = new Promise<void>(resolve => { bothRead = resolve })
      let count = 0
      vi.spyOn(f.sources, 'rootList').mockImplementation(async (...args) => {
        const roots = await rootList(...args)
        if (++count === 2) bothRead()
        if (count <= 2) await reads
        return roots
      })
      const bind = vi.spyOn(f.sources, 'bindRoot')
      const responses = await Promise.all([
        f.call('ci_run', { workspaceId: f.workspaceId, suite: 'unit', commandId: 'parallel-unit' }, 'operator'),
        f.call('ci_run', { workspaceId: f.workspaceId, suite: 'lint', commandId: 'parallel-lint' }, 'operator'),
      ])
      for (const [index, response] of responses.entries()) {
        expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true)
        const result = CiRunOutputSchema.parse(response.result.structuredContent)
        const read = await f.call('ci_get', { workspaceId: f.workspaceId, ticketId: result.ticketId }, 'operator')
        expect(CiGetOutputSchema.parse(read.result.structuredContent).queue.definition.name)
          .toBe(`CI: ${index === 0 ? 'unit' : 'lint'}`)
      }
      expect(bind).toHaveBeenCalledTimes(kind === 'same source' ? 2 : 3)
      expect(f.roots[0]!.binding.bindingRevision).toBe(kind === 'same source' ? 2 : 3)
      expect(f.counts().enqueues).toBe(2)
    } finally { await f.app.close() }
  })

  it('runs and reads CI with equivalent scoped Operator grants', async () => {
    const f = await fixture()
    try {
      const start = await f.call('ci_run', { workspaceId: f.workspaceId, suite: 'unit', commandId: 'operator-command' }, 'operator')
      const result = CiRunOutputSchema.parse(start.result.structuredContent)
      const get = await f.call('ci_get', { workspaceId: f.workspaceId, ticketId: result.ticketId }, 'operator')
      expect(CiGetOutputSchema.parse(get.result.structuredContent).queue.principalId).toBe(f.operator.id)
    } finally { await f.app.close() }
  })
})
