import Fastify from 'fastify'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema, CiCancelOutputSchema, CiLogsOutputSchema,
  CiArtifactsOutputSchema, CiArtifactOutputSchema } from '@foreman-code/contracts'
import { jobVerificationTemplate } from '@foreman-code/contracts/job-verification'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { DomainError } from '../src/modules/errors.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { CI_TOOLS } from '../src/mcp/shared/ciTools.js'
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
    tools: principal.id === 'disabled-agent' ? ['context_get'] : CI_TOOLS }),
  canRead: async () => false, canRespond: async () => false } as unknown as AppInteractionService
  registerGraphqlMcp(app, { access, operator: data.services, interactions })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  let requestId = 0
  const request = async (method: string, params: unknown, token = 'worker') => {
    const response = await fetch(new URL('/mcp', address), { method: 'POST',
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
  it.each(['worker', 'operator'])('queues integration with %s grants and retains its suite after recreation', async token => {
    const f = await fixture()
    try {
      f.templates.push(jobVerificationTemplate({ ...f.templates[0]!, suite: 'integration' }))
      const scope = token === 'operator' ? { workspaceId: f.workspaceId } : {}
      const tools = (await f.request('tools/list', {}, token)).result.tools
      expect(tools.find((tool: { name: string }) => tool.name === 'ci_run').inputSchema.properties.suite.enum)
        .toContain('integration')
      const input = { ...scope, suite: 'integration', commandId: 'integration-ci', placementOverride: { kind: 'auto' } }
      const response = await f.call('ci_run', input, token)
      expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true)
      const started = CiRunOutputSchema.parse(response.result.structuredContent)
      f.services.ci = f.createCi()
      expect(CiRunOutputSchema.parse((await f.call('ci_run', input, token)).result.structuredContent)).toEqual(started)
      const read = await f.call('ci_get', { ...scope, ticketId: started.ticketId }, token)
      expect(CiGetOutputSchema.parse(read.result.structuredContent).queue.definition.spec)
        .toMatchObject({ verification: { suite: 'integration' } })
      const denied = await f.call('ci_run', { ...input, workspaceId: f.workspaceId, commandId: 'denied-integration' }, 'readonly')
      expect(JSON.stringify(denied.result)).toContain('ACCESS_DENIED')
      expect(f.counts().enqueues).toBe(1)
      f.complete()
      const completed = await f.call('ci_get', { ...scope, ticketId: started.ticketId }, token)
      expect(CiGetOutputSchema.parse(completed.result.structuredContent)).toMatchObject({
        queue: { state: 'terminal' }, process: { outcome: 'succeeded' },
        summaryReport: { report: { suite: 'integration', outcome: 'passed' } },
      })
      expect((await f.call('ci_logs_read', { ...scope, ticketId: started.ticketId }, token)).result.isError).not.toBe(true)
      expect((await f.call('ci_artifacts_list', { ...scope, ticketId: started.ticketId }, token)).result.isError).not.toBe(true)
    } finally { await f.app.close() }
  })

  it('retains the caller’s preparation grants and explicit runtime selection on the queued ticket', async () => {
    const f = await fixture()
    try {
      const result = await f.call('ci_run', { workspaceId: f.workspaceId, suite: 'unit', commandId: 'queue-preparation' }, 'operator')
      expect(result.result.isError, JSON.stringify(result.result)).not.toBe(true)
      const ticket = f.ticket()
      expect(ticket.runtimePreparation?.id).toBe(f.operator.id)
      expect(ticket.runtimePreparation?.grants).toEqual(f.operator.grants)
      expect(ticket.definition.spec).toMatchObject({ runtimeSelection: 'qualified-profile' })
    } finally { await f.app.close() }
  })
  it('lists Agent schemas with no workspace selector and Operator schemas with workspaceId', async () => {
    const f = await fixture()
    try {
      const workerTools = (await f.request('tools/list', {})).result.tools
      expect(workerTools.map((tool: { name: string }) => tool.name)).toEqual(CI_TOOLS)
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
      expect(read).toMatchObject({ queue: { state: 'terminal', terminalReason: 'completed',
        selectedComputer: { profileId: 'profile' } },
        process: { outcome: 'succeeded', exitCode: 0 }, publication: 'complete',
        summaryReport: { report: { outcome: 'passed', commit: 'b'.repeat(40), totals: { total: 3 } } },
        logTail: { text: 'tests passed\n', truncated: false } })
      expect(f.audits).toContainEqual({ principalId: f.worker.id, action: 'ci.run', outcome: 'succeeded' })
      expect(f.roots.map(root => root.binding.bindingRevision)).toEqual([2, 1])
      const changed = await f.call('ci_run', { ...input, commit: 'c'.repeat(40) })
      expect(JSON.stringify(changed.result)).toContain('COMMAND_ID_CONFLICT')
    } finally { await f.app.close() }
  })

  it.each(['collecting', 'failed', 'expired'] as const)(
    'returns an available failure summary while publication is %s for Agent and Operator callers',
    async publication => {
      const f = await fixture()
      try {
        const start = await f.call('ci_run', { suite: 'unit', commandId: 'partial-results' })
        const { ticketId } = CiRunOutputSchema.parse(start.result.structuredContent)
        f.complete({ publication, failed: true })
        f.services.ci = f.createCi()
        for (const token of ['worker', 'operator']) {
          const input = token === 'operator' ? { workspaceId: f.workspaceId, ticketId } : { ticketId }
          const read = await f.call('ci_get', input, token)
          expect(read.result.isError).not.toBe(true)
          expect(CiGetOutputSchema.parse(read.result.structuredContent)).toMatchObject({
            publication,
            resultIssue: publication === 'failed' ? 'publication_failed' : null,
            process: { outcome: 'build_failed', exitCode: 1 },
            summaryReport: { report: { outcome: 'failed', totals: { total: 3, passed: 2, failed: 1 } } },
          })
        }
        const denied = await f.call('ci_get', { ticketId }, 'foreign')
        expect(JSON.stringify(denied.result)).toContain('ACCESS_DENIED')
      } finally { await f.app.close() }
    },
  )

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

  it('queues CI on the computers that accept the commit when another computer rejects its root', async () => {
    const f = await fixture()
    try {
      f.roots[1]!.offline = false
      f.roots[1]!.refusing = true
      const result = await f.call('ci_run', { suite: 'unit', commandId: 'one-refuses' })
      expect(result.result.isError, JSON.stringify(result.result)).not.toBe(true)
      CiRunOutputSchema.parse(result.result.structuredContent)
      expect(f.counts().enqueues).toBe(1)
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
      const initiatingAgent = { workflowId: 'workflow', runId: 'run', agentId: 'agent', executionId: 'execution-agent' }
      expect(read.queue).toMatchObject({ workflow: null, initiatingAgent })
      f.services.ci = f.createCi()
      const persisted = CiGetOutputSchema.parse((await f.call('ci_get', {
        workspaceId: f.workspaceId, ticketId: started.ticketId,
      }, 'operator')).result.structuredContent)
      expect(persisted.queue.initiatingAgent).toEqual(initiatingAgent)
      f.complete()
      const finished = CiGetOutputSchema.parse((await f.call('ci_get', {
        workspaceId: f.workspaceId, ticketId: started.ticketId,
      }, 'operator')).result.structuredContent)
      expect(finished.queue).toMatchObject({ state: 'terminal', terminalReason: 'completed', workflow: null, initiatingAgent })


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
      await runGit(['config', 'user.name', 'fixture'])
      await runGit(['config', 'user.email', 'fixture@example.invalid'])
      await runGit(['config', 'commit.gpgsign', 'false'])
      await writeFile(join(root, 'app.ts'), 'base\n')
      await runGit(['add', '.'])
      await runGit(['commit', '-qm', 'base'])
      const baseCommit = await runGit(['rev-parse', 'HEAD'])
      await writeFile(join(root, 'app.ts'), 'uncommitted agent work\n')
      f.agentExecution.id = 'execution-agent'
      let date = '2000-01-01T00:00:00Z'
      const snapshots = vi.fn(async () => snapshotAgentWorktree({
        git: (args, options) => git.git(args, { ...options, env: {
          ...options.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
        } }),
      }, { path: root, baseCommit }, AbortSignal.timeout(30_000)))
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

  it.each(['auto', 'prefer', 'explicit'] as const)('chooses %s placement for current Agent files and preserves the request on retry', async kind => {
    const f = await fixture()
    try {
      f.agentExecution.id = 'execution-agent'
      let placementOverride: unknown = { kind: 'auto' }
      if (kind === 'prefer') placementOverride = { kind, hostRef: f.buildTarget.hostRef }
      if (kind === 'explicit') placementOverride = { kind, target: f.buildTarget }
      const input = { suite: 'unit', commandId: 'remote-files', placementOverride }
      const result = await f.call('ci_run', input)
      expect(result.result.isError, JSON.stringify(result.result)).not.toBe(true)
      const started = CiRunOutputSchema.parse(result.result.structuredContent)
      expect(f.enqueued.at(-1)).toMatchObject({ placementOverride: input.placementOverride })
      expect(f.snapshotCalls[0]!.hostRef).toEqual({ kind: 'device', ...f.agent })
      expect(CiRunOutputSchema.parse((await f.call('ci_run', input)).result.structuredContent)).toEqual(started)
      expect(f.counts()).toEqual({ sourceCaptures: 1, enqueues: 1 })
      const changed = kind === 'auto' ? { kind: 'prefer', hostRef: f.buildTarget.hostRef } : { kind: 'auto' }
      expect((await f.call('ci_run', { ...input, placementOverride: changed })).result.isError).toBe(true)
      f.services.ci = f.createCi()
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId: started.ticketId })).result.structuredContent)
      expect(read.queue.placement).toEqual(input.placementOverride)
      expect(read.queue.definition.spec.source.commit).toBe('c'.repeat(40))
      expect((await f.call('ci_computers_list', {})).result.structuredContent.verificationTemplates).toEqual(f.templates)
    } finally { await f.app.close() }
  })

  it('reads complete sequenced logs and immutable artifacts through Agent and Operator MCP', async () => {
    const f = await fixture()
    try {
      const { ticketId } = CiRunOutputSchema.parse((await f.call('ci_run', {
        suite: 'unit', commandId: 'read-ci-files',
      })).result.structuredContent)
      expect(JSON.stringify((await f.call('ci_logs_read', { ticketId })).result)).toContain('CI_NOT_ACCEPTED')
      f.complete()
      f.services.ci = f.createCi()
      for (const token of ['worker', 'operator']) {
        const scope = token === 'operator' ? { workspaceId: f.workspaceId, ticketId } : { ticketId }
        const logs = CiLogsOutputSchema.parse((await f.call('ci_logs_read', scope, token)).result.structuredContent)
        expect(logs.chunks.map(chunk => chunk.text)).toEqual(['tests passed\n'])
        const next = await f.call('ci_logs_read', { ...scope, afterSequence: logs.nextCursor }, token)
        expect(CiLogsOutputSchema.parse(next.result.structuredContent).chunks).toEqual([])
        const listed = await f.call('ci_artifacts_list', scope, token)
        const artifact = CiArtifactsOutputSchema.parse(listed.result.structuredContent).artifacts[0]!
        const bytes = await f.call('ci_artifact_read', { ...scope,
          fileId: artifact.fileId, revisionId: artifact.revisionId }, token)
        const content = CiArtifactOutputSchema.parse(bytes.result.structuredContent)
        expect(content.artifact).toEqual(artifact)
        expect(JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')))
          .toMatchObject({ executionId: artifact.executionId, outcome: 'passed' })
        expect(JSON.stringify((await f.call('ci_artifact_read', { ...scope,
          fileId: artifact.fileId, revisionId: 'other-revision' }, token)).result)).toContain('JOB_ARTIFACT_NOT_FOUND')
      }
      for (const name of ['ci_logs_read', 'ci_artifacts_list', 'ci_artifact_read']) {
        const input = { ticketId, ...(name === 'ci_artifact_read'
          ? { fileId: 'summary-file', revisionId: 'summary-revision' } : {}) }
        expect(JSON.stringify((await f.call(name, input, 'foreign')).result)).toContain('ACCESS_DENIED')
        expect(JSON.stringify((await f.call(name, input, 'disabled')).result)).toContain('TOOL_NOT_ENABLED')
      }
      f.accepted.grants = [{ actions: ['jobs:read'], scope: { workspaceIds: [f.workspaceId] } }]
      expect(JSON.stringify((await f.call('ci_logs_read', { ticketId })).result)).toContain('ACCESS_DENIED')
      expect(JSON.stringify((await f.call('ci_artifacts_list', { ticketId })).result)).toContain('ACCESS_DENIED')
    } finally { await f.app.close() }
  })

  it('reads artifacts larger than 1 MiB in bounded pages without an HTTP escape', async () => {
    const f = await fixture()
    try {
      const { ticketId } = CiRunOutputSchema.parse((await f.call('ci_run', {
        suite: 'unit', commandId: 'large-artifact',
      })).result.structuredContent)
      f.complete()
      const listed = await f.call('ci_artifacts_list', { ticketId })
      const artifact = CiArtifactsOutputSchema.parse(listed.result.structuredContent).artifacts[0]!
      const bytes = Buffer.alloc(1024 * 1024 + 37, 42)
      vi.spyOn(f.jobs, 'readArtifact').mockResolvedValue({ artifact: { ...artifact, byteSize: bytes.length }, bytes })
      const input = { ticketId, fileId: artifact.fileId, revisionId: artifact.revisionId }
      const first = CiArtifactOutputSchema.parse((await f.call('ci_artifact_read', input)).result.structuredContent)
      expect(Buffer.from(first.content, 'base64').byteLength).toBe(1024 * 1024)
      expect(first.nextOffset).toBe(1024 * 1024)
      const last = CiArtifactOutputSchema.parse((await f.call('ci_artifact_read', {
        ...input, offset: first.nextOffset,
      })).result.structuredContent)
      expect(last.nextOffset).toBeNull()
      const restored = Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(last.content, 'base64')])
      expect(createHash('sha256').update(restored).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(JSON.stringify((await f.call('ci_artifact_read', { ...input, offset: bytes.length + 1 })).result))
        .toContain('INVALID_REQUEST')
    } finally { await f.app.close() }
  })

  it('cancels CI with revision checks, idempotent retries and denied-caller audit', async () => {
    const f = await fixture()
    try {
      const { ticketId } = CiRunOutputSchema.parse((await f.call('ci_run', {
        suite: 'unit', commandId: 'cancel-ci',
      })).result.structuredContent)
      const input = { ticketId, expectedRevision: 1, commandId: 'cancel-ticket' }
      const first = await f.call('ci_cancel', input)
      expect(first.result.isError).not.toBe(true)
      const cancelled = CiCancelOutputSchema.parse(first.result.structuredContent)
      expect(cancelled.ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', revision: 2 })
      f.services.ci = f.createCi()
      expect(CiCancelOutputSchema.parse((await f.call('ci_cancel', input)).result.structuredContent)).toEqual(cancelled)
      const read = CiGetOutputSchema.parse((await f.call('ci_get', { ticketId })).result.structuredContent)
      expect(read.queue).toEqual(cancelled.ticket)
      const stale = await f.call('ci_cancel', { ...input, commandId: 'stale-cancel' })
      expect(JSON.stringify(stale.result)).toContain('JOB_QUEUE_REVISION_CONFLICT')
      expect(JSON.stringify((await f.call('ci_cancel', input, 'foreign')).result)).toContain('ACCESS_DENIED')
      expect(JSON.stringify((await f.call('ci_cancel', input, 'disabled')).result)).toContain('TOOL_NOT_ENABLED')
      const denied = await f.call('ci_cancel', { ...input, workspaceId: f.workspaceId }, 'readonly')
      expect(JSON.stringify(denied.result)).toContain('ACCESS_DENIED')
      expect(f.audits).toContainEqual({ principalId: f.readonly.id, action: 'ci_cancel', outcome: 'denied' })
      expect(f.audits).toContainEqual({ principalId: f.accepted.id, action: 'job.queue.cancel', outcome: 'succeeded' })
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
