import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresSettingsRepository } from '../../src/modules/settings/postgres.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { HarnessQualificationRepository } from '../../src/modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from '../../src/modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from '../../src/modules/harnesses/qualification/service.js'
import { codexQualificationSuite, opencodeQualificationSuite, withNativeQualificationOwnership,
  NativeProcessRegistry } from '../../src/modules/harnesses/qualification/cliEntry.js'
import { nativeCompatibilityProbe } from '../../src/modules/harnesses/compatibility/probe.js'
import { clearQualificationGate, installQualificationGate } from '../../src/modules/harnesses/qualification/gate.js'
import { ManagedOpenCodeServer } from '../../src/modules/harnesses/opencodeServer.js'
import { record } from '../../src/modules/harnesses/nativeMcpCommon.js'

/** Actual qualification through the audited service; never seed a qualified row
 * or mark a version trusted from a serialized CLI result. Own schema/resources only. */
export async function qualifyEng03OpenCode() {
  const configured = process.env.ENG03_A_TEST_DATABASE_URL
  assert.ok(configured)
  const url = new URL(configured)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.includes('test'))
  const schema = `native_qualification_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: configured, max: 1 })
  await admin.query(`create schema ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema},public`)
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 })
  const directory = await mkdtemp(join(tmpdir(), 'eng03-qualification-'))
  const processes = new NativeProcessRegistry(join(directory, 'native-process-registry'))
  let service: HarnessQualificationService | undefined
  const close = async () => {
    clearQualificationGate()
    await service?.shutdown()
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await applyApplicationMigrations(pool)
    const settings = new PostgresSettingsRepository(pool)
    const defaults = await settings.getHarnessDefaults()
    await settings.saveHarnessDefaults({
      ...defaults,
      opencode: {
        ...defaults.opencode,
        model: process.env.ENG03_OPENCODE_MODEL ?? 'opencode-go/gpt-5.6-luna',
      },
    })
    const repository = new HarnessQualificationRepository(pool)
    const registry = new HarnessQualificationRegistry(repository,
      { codex: codexQualificationSuite.revision, opencode: opencodeQualificationSuite.revision })
    const binaries = { codex: process.env.ENG03_A_CODEX_BINARY ?? 'codex',
      opencode: process.env.ENG03_A_OPENCODE_BINARY ?? process.env.OPENCODE_BINARY ?? 'opencode' }
    const metadata = new ManagedOpenCodeServer({ binary: binaries.opencode, workingDirectory: directory,
      ownerAgentId: 'qualification-metadata', appMcpAccess: 'none',
      processRecovery: processes.scope(`qualification-metadata:${randomUUID()}`) })
    try {
      const signal = AbortSignal.timeout(30_000)
      await metadata.ensure(signal)
      const response = await metadata.request('/provider', { method: 'GET' }, signal)
      assert.ok(response.ok, 'Native provider metadata is unavailable')
      const catalog = record(await response.json())
      const model = process.env.ENG03_OPENCODE_MODEL ?? 'opencode-go/gpt-5.6-luna'
      const [providerId, ...modelId] = model.split('/')
      const providers = Array.isArray(catalog.all) ? catalog.all.map(record) : []
      const provider = providers.find(item => item.id === providerId)
      console.info('OPENCODE_ACCEPTANCE_PROVIDER', JSON.stringify({ model,
        connected: Array.isArray(catalog.connected) && catalog.connected.includes(providerId),
        providerAdvertised: provider !== undefined,
        modelAdvertised: provider !== undefined && Object.hasOwn(record(provider.models), modelId.join('/')),
      }))
    } finally {
      await metadata.dispose()
    }
    const selected = await registry.inspectBinary(binaries.opencode)
    const checker = await registry.inspectBinary(process.execPath)
    const guard = (binary: string, sha256: string) => async (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      assert.equal((await registry.inspectBinary(binary)).sha256, sha256, 'Native binary changed during qualification')
      signal?.throwIfAborted()
    }
    const suites = { codex: withNativeQualificationOwnership(codexQualificationSuite, processes,
      (input) => guard(input.binary, input.binarySha256)),
    opencode: withNativeQualificationOwnership(opencodeQualificationSuite, processes,
      (input) => guard(input.binary, input.binarySha256)) }
    service = new HarnessQualificationService(repository, registry, suites, binaries,
      new PostgresCommandCoordinator(pool), settings, undefined, undefined,
      (_harness, binary, timeoutMs) => nativeCompatibilityProbe({ codex: binary, opencode: binary }, directory,
        process.env, timeoutMs, { recovery: processes.scope(`qualification-probe:${randomUUID()}`),
          beforeCommand: async (current, signal) => {
            const original = current === process.execPath ? checker : selected
            assert.equal((await registry.inspectBinary(current)).binary, original.binary)
            await guard(original.binary, original.sha256)(signal)
          } }))
    const authority = await new PostgresAccessService(pool).issue({ name: 'ENG03 owned qualification', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] })
    const submitted = (await service.run(authority.principal, 'http', 'opencode')).qualification
    assert.ok(submitted.binarySha256)
    let qualification = submitted
    const deadline = Date.now() + 350_000
    while (qualification.status === 'qualifying' && Date.now() < deadline) {
      await delay(250)
      qualification = await repository.find('opencode', submitted.version, submitted.binarySha256,
        submitted.suiteRevision) ?? submitted
    }
    const evidenceDirectory = process.env.ENG03_A_EVIDENCE_DIR
      ?? fileURLToPath(new URL('../../../../.logs/eng03-a-evidence/', import.meta.url))
    const records = (await pool.query(`select harness,version,binary_sha256,suite_revision,status,checks,evidence,
      failure_reason,started_at,checked_at from harness_qualifications order by started_at`)).rows
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
    const artifact = join(evidenceDirectory, `opencode-qualification-${randomUUID()}.json`)
    await writeFile(artifact, JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 })
    console.info(`OpenCode qualification evidence ${artifact}`)
    assert.equal(qualification.status, 'qualified', JSON.stringify(qualification))
    assert.ok(qualification.binarySha256)
    assert.equal(await registry.trustedExact('opencode', qualification.version, qualification.binarySha256), true)
    installQualificationGate(registry, service)
    return close
  } catch (error) { await close(); throw error }
}
