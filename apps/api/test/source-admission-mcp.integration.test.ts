import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { jobVerificationTemplate } from '@foreman-code/contracts/job-verification'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { SourceApproveResultSchema, SourceListResultSchema, ApprovedSourceSchema, SourceRootBindResultSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { PostgresWorkspaceRootPolicies } from '../src/modules/sources/rootPolicies.js'
import { InstalledWorkspaceRootHosts } from '../src/modules/sources/rootHosts.js'
import { RegisteredWorkspaceSourceRoots } from '../src/modules/sources/registeredSourceRoots.js'
import { qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { qualifiedGit } from '../src/modules/sources/capture.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { CiService } from '../src/modules/jobs/ci.js'
import { RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { ciFixture } from './helpers/ciFixture.js'
import { jobDigest } from '../src/modules/jobs/digest.js'

/** Root-only DB fixture: real authenticated /mcp, actual workspace/installation,
 * canonical Git capture and persisted readback. The fixture registered-root
 * authority uses the real generic policy/host helper modules; native/remote execution is intentionally not invoked.
 */
it.skipIf(!process.env.TEST_DATABASE_URL)('admits exact approved sources and roots through authenticated MCP without caller paths or fake Run/Agent', async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const url = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) throw new Error('Use an owned disposable loopback test database.')
  const schema = `source_mcp_${randomUUID().replaceAll('-', '')}`, directory = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/source-mcp-`)
  const admin = new pg.Pool({ connectionString }); await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  const commands = new PostgresCommandCoordinator(pool), access = new PostgresAccessService(pool)
  const project = join(directory, 'project'), canonical = join(directory, 'canonical-source'), runtime = join(directory, 'runtime')
  for (const path of [project, canonical, runtime]) await mkdir(path, { mode: 0o700 })
  const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local', directory)
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  let app: ReturnType<typeof buildApp> | undefined
  try {
    await applyApplicationMigrations(pool)
    const mainId = (await pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
    const owner = await access.issue({ name: 'Source owner', audience: 'operator', grants: [{ actions: [...ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 300_000) })
    const created = await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Source workspace' })
    const workspace = created.value.workspace
    await workspaces.update(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedRevision: created.value.revision,
      repository: { provider: 'github', owner: 'original', name: 'site', defaultBranch: 'main' } })
    const located = await locations.set(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(), expectedLocationRevision: created.value.locationRevision, runnerId: locations.runnerId, rootPath: project })
    await qualifiedGit(project, ['init', '--template=']); await writeFile(join(project, 'source.ts'), 'export const revision = 1\n')
    await qualifiedGit(project, ['add', '.']); await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source1'])
    const commit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
    const nativeNotInvoked = async (): Promise<never> => { throw new Error('This source metadata fixture does not invoke native execution.') }
    const approvedRoots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
    const hosts = new InstalledWorkspaceRootHosts(approvedRoots, async (sql, _principal, host, installationId) => {
      const main = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
      if (host.kind !== 'main' || host.mainId !== main?.id || installationId !== main.id) throw new Error('Wrong actual main installation.')
      return null
    }, { request: nativeNotInvoked })
    const policies = new PostgresWorkspaceRootPolicies(mainId, hosts)
    const sql = await pool.connect()
    let authorized: Awaited<ReturnType<typeof policies.authorize>>
    try {
      await sql.query('begin')
      await policies.publishApprovedHostConfiguration(sql, approvedRoots, { mainId, hostRef: approvedRoots.hostRef, applicationInstallationId: mainId,
        configurationRevision: '1', configurationDigest: sourceSha256(Buffer.from(JSON.stringify(approvedRoots))) })
      authorized = await policies.authorize(sql, owner.principal, { workspaceId: workspace.id, hostRef: approvedRoots.hostRef,
        allowedBaseId: approvedRoots.bases[0]!.baseId, configurationRevision: '1', relativePath: '', accessMode: 'read-write', expectedLocationRevision: located.value.locationRevision, expectedRootPolicyRevision: 0 })
      await sql.query('commit')
    } finally { sql.release() }
    const attestation = await policies.attest(authorized)
    const bindingSql = await pool.connect()
    let policy: Awaited<ReturnType<typeof policies.bind>>
    try {
      await bindingSql.query('begin'); await policies.fence(bindingSql, authorized)
      await bindingSql.query('update workspaces set location_revision=location_revision+1 where id=$1 and location_revision=$2', [workspace.id, located.value.locationRevision])
      policy = await policies.bind(bindingSql, owner.principal, authorized, attestation, located.value.locationRevision + 1)
      await bindingSql.query('commit')
    } finally { bindingSql.release() }
    const roots = new RegisteredWorkspaceSourceRoots(policies, hosts)
    const sources = new PostgresSourceService(pool, commands, locations, new PrivateSourceSnapshotStore(canonical), mainId, roots,
      { authorize: nativeNotInvoked, prepare: nativeNotInvoked, verifyWorkingDirectory: nativeNotInvoked, verify: nativeNotInvoked, releaseClaim: nativeNotInvoked, authorizeFinal: nativeNotInvoked }, { confirmedClosed: nativeNotInvoked })
    const ciData = ciFixture()
    const createCi = () => new CiService(pool, new PostgresCommandCoordinator(pool),
      new RunCiAuthority(pool), sources, ciData.jobs)
    const services = { commands, workspaces, locations, sources, ci: createCi() } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const operator = await access.issue({ name: 'Scoped source Operator', audience: 'operator', grants: [{ actions: ['sources:read', 'sources:approve', 'source_roots:read', 'source_roots:bind', 'workspace_locations:read'], scope: { workspaceIds: [workspace.id] } }], expiresAt: new Date(Date.now() + 240_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [operator.principal.id, owner.principal.id])
    async function connect(token: string) { const client = new Client({ name: 'source-fixture', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    const client = await connect(operator.token)
    const approve = { workspaceId: workspace.id, commandId: randomUUID(), expectedLocationRevision: Number(policy.locationRevision), commit, approvedPaths: ['source.ts'], executablePolicy: 'strip' }
    const firstCall = await client.callTool({ name: 'source_approve', arguments: approve })
    expect(firstCall.isError, JSON.stringify(firstCall)).not.toBe(true)
    const first = SourceApproveResultSchema.parse(decodeMcpToolResult(firstCall))
    const replay = SourceApproveResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_approve', arguments: approve }))))
    expect(replay.replayed).toBe(true); expect(replay.value).toEqual(first.value)
    const pin = { approvedSourceId: first.value.manifest.approvedSourceId, snapshotId: first.value.manifest.snapshotId, manifestDigest: first.value.manifest.manifestDigest }
    const read = ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } }))))
    expect(read.manifest.git?.commit).toBe(commit)
    expect(read.manifest.git?.repository).toBe('original/site')
    expect(read.manifest.git?.metadata).toMatchObject({ byteSize: expect.any(Number), sha256: expect.any(String) })
    const beforeEdit = await workspaces.get(owner.principal, workspace.id)
    const changed = await workspaces.update(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedRevision: beforeEdit.revision,
      repository: { provider: 'github', owner: 'other', name: 'site', defaultBranch: 'main' } })
    await workspaces.update(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedRevision: changed.value.revision, repository: null })
    const retained = ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get',
      arguments: { workspaceId: workspace.id, ...pin } }))))
    expect(retained.manifest.git?.repository).toBe('original/site')
    expect(retained.manifest).toEqual(read.manifest)
    const bind = { workspaceId: workspace.id, commandId: randomUUID(), source: pin, selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }, expectedBindingRevision: 0, accessMode: 'exclusive-write' }
    const rootResult = await client.callTool({ name: 'source_root_bind', arguments: bind })
    expect(rootResult.isError, JSON.stringify(rootResult)).not.toBe(true)
    const bound = SourceRootBindResultSchema.parse(decodeMcpToolResult(rootResult)).value
    expect(bound.binding.deviceId).toBeNull(); expect(bound.binding.workerInstallationId).toBeNull()
    const rootRead = SourceRootRecordSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_root_get', arguments: { workspaceId: workspace.id, rootId: bound.binding.rootId, bindingRevision: 1 } }))))
    expect(rootRead).toEqual(bound)

    const ciClient = await connect(owner.token)
    const ciInput = { workspaceId: workspace.id, suite: 'unit', commandId: randomUUID() }
    const choices = vi.spyOn(ciData.jobs, 'choices')
    choices.mockRejectedValueOnce(new Error('Interrupted after source approval commits'))
    expect((await ciClient.callTool({ name: 'ci_run', arguments: ciInput })).isError).toBe(true)
    const sourceCommand = `${jobDigest({ callerId: owner.principal.id, commandId: ciInput.commandId })}:source`
    const original = (await pool.query<{ record: unknown }>(`select s.record from source_approvals a
      join source_snapshots s on s.snapshot_id=a.snapshot_id where a.requested_by=$1 and a.command_id=$2`,
    [owner.principal.id, sourceCommand])).rows[0]!
    const originalSource = ApprovedSourceSchema.parse(original.record)
    expect(originalSource.manifest.git!.commit).toBe(commit)
    await writeFile(join(project, 'source.ts'), 'export const revision = 3\n')
    await qualifiedGit(project, ['add', '.'])
    await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'advance while CI is interrupted'])
    services.ci = createCi()
    const recoveredCall = await ciClient.callTool({ name: 'ci_run', arguments: ciInput })
    expect(recoveredCall.isError, JSON.stringify(recoveredCall.content)).not.toBe(true)
    const recovered = CiRunOutputSchema.parse(decodeMcpToolResult(recoveredCall))
    const ciRead = await ciClient.callTool({ name: 'ci_get', arguments: {
      workspaceId: workspace.id, ticketId: recovered.ticketId,
    } })
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(ciRead)).queue.definition.spec.source).toMatchObject({
      snapshotId: originalSource.manifest.snapshotId, commit,
    })
    const sourceRead = await ciClient.callTool({ name: 'source_get', arguments: {
      workspaceId: workspace.id, approvedSourceId: originalSource.manifest.approvedSourceId,
      snapshotId: originalSource.manifest.snapshotId, manifestDigest: originalSource.manifest.manifestDigest,
    } })
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult(sourceRead))).toEqual(originalSource)
    expect(CiRunOutputSchema.parse(decodeMcpToolResult((await ciClient.callTool({ name: 'ci_run', arguments: ciInput })))))
      .toEqual(recovered)
    expect(ciData.counts().enqueues).toBe(1)

    const available = await ciData.jobs.choices(owner.principal, workspace.id, 'mcp')
    const unit = available.verificationTemplates![0]!
    choices.mockResolvedValue({ ...available, verificationTemplates: [unit,
      jobVerificationTemplate({ ...unit, suite: 'lint' })] })
    const listRoots = sources.rootList.bind(sources)
    let bothRead!: () => void
    const concurrentReads = new Promise<void>(resolve => { bothRead = resolve })
    let readCount = 0
    const rootReads = vi.spyOn(sources, 'rootList').mockImplementation(async (...args) => {
      const listed = await listRoots(...args)
      if (++readCount === 2) bothRead()
      if (readCount <= 2) await concurrentReads
      return listed
    })
    const parallel = await Promise.all(['unit', 'lint'].map(suite => ciClient.callTool({ name: 'ci_run',
      arguments: { workspaceId: workspace.id, suite, commandId: randomUUID() } })))
    rootReads.mockRestore()
    choices.mockRestore()
    for (const response of parallel) {
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      const queued = CiRunOutputSchema.parse(decodeMcpToolResult(response))
      const read = await ciClient.callTool({ name: 'ci_get', arguments: {
        workspaceId: workspace.id, ticketId: queued.ticketId,
      } })
      expect(CiGetOutputSchema.parse(decodeMcpToolResult(read)).queue.state).toBe('waiting')
    }
    const persistedRoots = await sources.rootList(owner.principal, 'mcp', { workspaceId: workspace.id, limit: 100 })
    expect(persistedRoots.items[0]!.binding.bindingRevision).toBe(4)
    const unchangedRevision = await client.callTool({ name: 'source_root_bind', arguments: {
      ...bind, commandId: randomUUID(),
    } })
    expect(unchangedRevision.isError).toBe(true)
    expect(JSON.stringify(unchangedRevision.content)).toContain('SOURCE_ROOT_REVISION_CONFLICT')
    const wrong = await client.callTool({ name: 'source_approve', arguments: { ...approve, rootPath: '/home/other', runId: 'invented', agentId: 'invented' } })
    expect(wrong.isError).toBe(true)
    const denied = await access.issue({ name: 'Other scope', audience: 'operator', grants: [{ actions: ['sources:read', 'sources:approve', 'workspace_locations:read'], scope: { workspaceIds: ['workspace-other'] } }], expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await connect(denied.token)
    expect((await deniedClient.callTool({ name: 'source_approve', arguments: { ...approve, commandId: randomUUID() } })).isError).toBe(true)
    expect((await deniedClient.callTool({ name: 'ci_run', arguments: {
      workspaceId: workspace.id, suite: 'unit', commandId: randomUUID(),
    } })).isError).toBe(true)
    expect(Number((await pool.query<{ count: string }>(`select count(*) from management_audit where principal_id=$1 and outcome='denied'`, [denied.principal.id])).rows[0]!.count)).toBeGreaterThan(0)
    const reader = await access.issue({ name: 'Read-only source', audience: 'operator', grants: [{ actions: ['sources:read'], scope: { workspaceIds: [workspace.id] } }], expiresAt: new Date(Date.now() + 120_000) })
    const readerClient = await connect(reader.token)
    expect((await readerClient.listTools()).tools.map(t => t.name)).not.toContain('source_approve')
    await writeFile(join(project, 'source.ts'), 'export const revision = 2\n'); await qualifiedGit(project, ['add', '.']); await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source2'])
    const newCommit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
    const second = await client.callTool({ name: 'source_approve', arguments: { ...approve, commandId: randomUUID(), commit: newCommit } }); expect(second.isError).not.toBe(true)
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } })))).manifest.git?.commit).toBe(commit)
    expect(SourceListResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_list', arguments: { workspaceId: workspace.id } })))).items).toHaveLength(5)
    const http = await app.inject({ method: 'POST', url: `/api/management/workspaces/${workspace.id}/sources/get`, headers: { authorization: `Bearer ${operator.token}` }, payload: pin })
    expect(http.statusCode).toBe(200); expect(ApprovedSourceSchema.parse(http.json()).manifest.manifestDigest).toBe(pin.manifestDigest)
    await pool.query(`update source_snapshots set availability='unavailable' where snapshot_id=$1`, [pin.snapshotId])
    expect((await client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } })).isError).toBe(true)
    expect((await client.callTool({ name: 'source_approve', arguments: approve })).isError).toBe(true)
    await access.revoke(owner.principal.id)
    await expect(access.authenticate(operator.token)).rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 401 })
    await expect(client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } })).rejects.toThrow('Unauthorized')
  } finally {
    vi.restoreAllMocks()
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close(); await pool.end(); await dropFixtureSchema(admin, schema); await admin.end(); await removeFixtureDirectory(directory)
  }
}, 180_000)
