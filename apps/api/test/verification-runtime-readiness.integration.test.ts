import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { JobAuthoringChoicesRecordSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { JobRuntimeProfileListRecordSchema, JobVerificationProfileSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { buildApp } from '../src/app.js'
import { registerJobRoutes } from '../src/routes/jobs.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { verificationJobsMcpFixture } from './helpers/verificationJobsMcpFixture.js'

it.each(['unavailable', 'changed'] as const)('reports %s runtime templates consistently through HTTP and MCP', async state => {
  const f = await verificationJobsMcpFixture()
  const workspaceId = f.retained.workspaceId
  const jobs = f.createJobs()
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: f.access, services: { commands: f.retained.commands, jobs,
      jobRuntimeProfiles: f.profiles } as unknown as OperatorServices },
  })
  registerJobRoutes(app, jobs)
  registerJobRuntimeProfileRoutes(app, f.profiles)
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'Verification readiness test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      return client
    }
    const writer = await connect(f.writer.token)
    const reader = await connect(f.reader.token)
    const result = await writer.callTool({ name: 'job_runtime_profile_save', arguments: {
      workspaceId, commandId: randomUUID(), expectedRevision: null, name: 'Runtime readback profile', spec: {
        rootId: f.retained.root.binding.rootId, bindingRevision: f.retained.root.binding.bindingRevision,
        resources: f.seed.spec.verification.resources, policy: jobPolicyRequirementsRecord(f.seed.spec.policy),
        suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS },
      },
    } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const profile = z.object({ profile: JobVerificationProfileSchema }).parse(result.structuredContent).profile
    const qualified = await f.qualify(profile)
    const fingerprint = qualified.measurement!.fingerprint
    const snapshots = async () => (await f.database.pool.query(
      `select p.record as profile,a.record as approval,a.measurement
       from job_runtime_profiles p join job_runtime_qualification_approvals a on a.profile_id=p.id
       where p.id=$1 and a.id=$2`, [profile.id, qualified.measurement!.identity.approvalId])).rows[0]
    const saved = await snapshots()
    const choices = async () => {
      const response = await reader.callTool({ name: 'job_choices_get', arguments: { workspaceId } })
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      const mcp = JobAuthoringChoicesRecordSchema.parse(response.structuredContent)
      const http = await app.inject({ method: 'GET', url: `/api/management/workspaces/${workspaceId}/jobs/choices`,
        headers: { authorization: `Bearer ${f.reader.token}` } })
      expect(http.statusCode, http.body).toBe(200)
      expect(JobAuthoringChoicesRecordSchema.parse(http.json())).toEqual(mcp)
      return mcp.verificationTemplates!.find(template => template.profileId === profile.id)
    }
    expect(await choices()).toMatchObject({ ready: true })
    if (state === 'unavailable') f.runtimeMetadata.delete(profile.id)
    else f.runtimeMetadata.set(profile.id, { ...fingerprint, runtimeBinarySha256: 'b'.repeat(64) })
    expect(await choices()).toMatchObject({ ready: false })
    const read = await reader.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId } })
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
    expect(JobRuntimeProfileListRecordSchema.parse(read.structuredContent).profiles
      .find(value => value.profile.id === profile.id)).toMatchObject({
      profile: qualified, ready: false,
      reasons: [state === 'unavailable' ? 'runtime_context_unavailable' : 'runtime_context_changed'],
    })
    const denied = await f.access.issue({ name: 'Caller without job access', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const deniedClient = await connect(denied.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'job_choices_get', arguments: { workspaceId } }))
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId } }))
    expect((await app.inject({ method: 'GET', url: `/api/management/workspaces/${workspaceId}/jobs/choices`,
      headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
    expect(await snapshots()).toEqual(saved)
    f.runtimeMetadata.set(profile.id, fingerprint)
    expect(await choices()).toMatchObject({ ready: true })
    expect(await snapshots()).toEqual(saved)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await jobs.closeQueue()
    await f.runtime.close()
    await f.database.close()
  }
}, 60_000)
