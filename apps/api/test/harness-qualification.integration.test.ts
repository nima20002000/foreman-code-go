import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { HarnessQualificationListSchema } from '@graphql/contracts/harness-qualification'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { harnessQualificationMigration } from '../src/infrastructure/harnessQualificationMigration.js'
import { migrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessQualificationRepository } from '../src/modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from '../src/modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { clearQualificationGate, installQualificationGate, requireHarnessQualification } from '../src/modules/harnesses/qualification/gate.js'
import type { QualificationSuite } from '../src/modules/harnesses/qualification/types.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('registers the qualification migration after earlier blocks', () => {
  expect(migrations.at(-1)).toBe(harnessQualificationMigration)
  expect(new Set(migrations.map((migration) => migration.version)).size).toBe(migrations.length)
})

it.skipIf(!process.env.TEST_DATABASE_URL)('runs a fake suite through authenticated HTTP and MCP, denies a reader, and reads persisted trust', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `harness_qualification_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const home = await mkdtemp(join(tmpdir(), 'harness-qualification-test-'))
  const binary = join(home, 'fake-codex')
  await writeFile(binary, '#!/bin/sh\necho "codex-cli 0.158.0"\n')
  await chmod(binary, 0o700)
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    await applyApplicationMigrations(pool)
    const access = new PostgresAccessService(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const repository = new HarnessQualificationRepository(pool)
    const registry = new HarnessQualificationRegistry(repository, { codex: 'fake-v1', opencode: 'fake-v1' })
    const suite: QualificationSuite = { harness: 'codex', revision: 'fake-v1', run: vi.fn(async () => ({
      checks: [{ id: 'protocol', passed: true, detail: null }], evidence: { fixture: true },
    })) }
    const staticCheck = vi.fn(async () => 'a'.repeat(64))
    const service = new HarnessQualificationService(repository, registry, { codex: suite, opencode: { ...suite, harness: 'opencode' } },
      { codex: binary, opencode: binary }, commands, staticCheck)
    installQualificationGate(registry, service)
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).rejects.toMatchObject({ result: { error: { code: 'HARNESS_QUALIFYING', retryable: true } } })
    const services = { commands, harnessQualifications: service } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    const writer = await access.issue({ name: 'Qualification writer', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'Qualification reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'qualification-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const writeClient = await connect(writer.token)
    const readClient = await connect(reader.token)
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_qualification_run')
    await expect(readClient.callTool({ name: 'harness_qualification_run', arguments: { harness: 'codex' } })).rejects.toThrow('not found')
    const started = await writeClient.callTool({ name: 'harness_qualification_run', arguments: { harness: 'codex' } })
    expect(started.isError).not.toBe(true)
    await viWaitFor(async () => expect((await repository.list())[0]?.status).toBe('qualified'))
    const listed = HarnessQualificationListSchema.parse((await readClient.callTool({ name: 'harness_qualifications_list', arguments: {} })).structuredContent)
    expect(listed.qualifications[0]).toMatchObject({ harness: 'codex', version: '0.158.0', status: 'qualified', suiteRevision: 'fake-v1',
      checks: [{ id: 'static-compatibility', passed: true }, { id: 'protocol', passed: true }] })
    expect(await registry.trusted('codex', '0.158.0', listed.qualifications[0]!.binarySha256!)).toBe(true)
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).resolves.toBeUndefined()
    expect(await registry.trusted('codex', '0.158.0', '0'.repeat(64))).toBe(false)
    const http = await app.inject({ method: 'GET', url: '/api/management/harnesses/qualifications', headers: { authorization: `Bearer ${reader.token}` } })
    expect(http.statusCode).toBe(200)
    expect(HarnessQualificationListSchema.parse(http.json()).qualifications).toHaveLength(1)
    const denied = await app.inject({ method: 'POST', url: '/api/management/harnesses/codex/qualification', headers: { authorization: `Bearer ${reader.token}` } })
    expect(denied.statusCode).toBe(403)
    await writeFile(binary, '#!/bin/sh\n# another binary, same version\necho "codex-cli 0.158.0"\n')
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).rejects.toMatchObject({
      result: { error: { code: 'HARNESS_QUALIFYING', retryable: true } },
    })
    await viWaitFor(async () => expect((await repository.list()).filter((item) => item.suiteRevision === 'fake-v1' && item.status === 'qualified')).toHaveLength(2))
    expect(suite.run).toHaveBeenCalledTimes(3)
    expect(staticCheck).toHaveBeenCalledTimes(3)
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).resolves.toBeUndefined()
    const failedSuite: QualificationSuite = { harness: 'codex', revision: 'fake-v2', run: async () => ({
      checks: [{ id: 'protocol', passed: false, detail: 'fixture mismatch' }], evidence: { fixture: true },
    }) }
    const failedRegistry = new HarnessQualificationRegistry(repository, { codex: 'fake-v2', opencode: 'fake-v1' })
    const failedService = new HarnessQualificationService(repository, failedRegistry, { codex: failedSuite, opencode: { ...suite, harness: 'opencode' } },
      { codex: binary, opencode: binary }, commands, staticCheck)
    await failedService.begin('codex')
    await viWaitFor(async () => expect((await repository.list()).find((item) => item.suiteRevision === 'fake-v2')?.status).toBe('failed'))
    installQualificationGate(failedRegistry, failedService)
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).rejects.toMatchObject({
      result: { error: { code: 'HARNESS_UNQUALIFIED' } },
    })
    const skippedSuite: QualificationSuite = { ...suite, revision: 'fake-v3', run: vi.fn(async () => ({ checks: [], evidence: {} })) }
    const staticFailure = new HarnessQualificationService(repository,
      new HarnessQualificationRegistry(repository, { codex: 'fake-v3', opencode: 'fake-v1' }),
      { codex: skippedSuite, opencode: { ...suite, harness: 'opencode' } },
      { codex: binary, opencode: binary }, commands, async () => { throw new Error('schema missing required method') })
    await staticFailure.begin('codex')
    await viWaitFor(async () => expect((await repository.list()).find((item) => item.suiteRevision === 'fake-v3')).toMatchObject({
      status: 'failed', checks: [{ id: 'static-compatibility', passed: false, detail: 'schema missing required method' }],
    }))
    expect(skippedSuite.run).not.toHaveBeenCalled()
  } finally {
    clearQualificationGate()
    await Promise.allSettled(clients.map((client) => client.close()))
    await app?.close()
    await pool.end()
    await rm(home, { recursive: true, force: true })
    await admin.query(`drop schema if exists "${schema}" cascade`)
    await admin.end()
  }
}, 60_000)

async function viWaitFor(check: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await check(); return } catch { await new Promise((resolve) => setTimeout(resolve, 25)) }
  }
  await check()
}
