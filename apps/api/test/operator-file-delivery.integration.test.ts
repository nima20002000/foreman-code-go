import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { FileMediaType, MessageAttachmentRef } from '@graphql/contracts/files'
import type { ApiConfig } from '../src/config.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { FixtureServer, configuration as openCodeConfiguration, json } from './opencode-fixtures.js'
import { calls, finish, fixtureQualification, input, until, type Fixture } from './fixtures/codex-test-helpers.js'
import { fileRuntimeFixture } from './fixtures/codex-file-runtime-helpers.js'

// Provider qualification/transport and the native OS attestation are fixtures.
// Production manager selection, both native session managers/bridges, receipt
// admission, PostgreSQL file tools, checksums and host materialization are REAL.
// This does not qualify a real OpenCode process's source-vault isolation.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const servers: FixtureServer[] = []
const serverOptions: Array<{ appMcpAccess?: string; credentialEnvironmentVariable?: string }> = []
vi.doMock('../src/modules/harnesses/opencodeServer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/opencodeServer.js')>('../src/modules/harnesses/opencodeServer.js')
  return { ...actual, ManagedOpenCodeServer: class extends FixtureServer {
    constructor(options: ConstructorParameters<typeof actual.ManagedOpenCodeServer>[0]) {
      super()
      serverOptions.push(options)
      this.config = { mcp: { graphql: { enabled: false } } }
      this.mcp = { graphql: { status: 'disabled' } }
      this.beforeRequest = (path, init) => {
        if (new URL(path, 'http://fixture.invalid').pathname === '/mcp' && init.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { name: string }
          this.mcp[body.name] = { status: 'connected' }
          return json(this.mcp)
        }
        return undefined
      }
      this.onPrompt = (id, body) => {
        const partial = this.assistant(String(body.messageID), 'working', undefined, false, id)
        this.emit('message.updated', { info: partial.info })
        for (const part of partial.parts) this.emit('message.part.updated', { part })
      }
      servers.push(this)
    }
  } }
})
vi.doMock('../src/modules/harnesses/opencodeFiles/host.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/opencodeFiles/host.js')>('../src/modules/harnesses/opencodeFiles/host.js')
  return { ...actual, assertProtectedSourcePaths: async () => undefined }
})
const { applyApplicationMigrations } = await import('../src/infrastructure/migrations.js')
const { PostgresAccessService } = await import('../src/modules/access/postgres.js')
const { PostgresOperatorRepository } = await import('../src/modules/operators/postgres.js')
const { PostgresOperatorChatAuthority } = await import('../src/modules/conversations/operatorChatAuthority.js')
const { OperatorChatService, PostgresOperatorConversationRepository } = await import('../src/modules/conversations/operatorChat.js')
const { nativeCorrelation } = await import('../src/modules/conversations/operatorChatRepository.js')
const { registerProductionFileStorage } = await import('../src/modules/files/production.js')
const { productionFileTools } = await import('../src/modules/files/tools/production.js')
const { NativeRollout } = await import('../src/modules/harnesses/nativeRollout.js')
const { NativeProcessRegistry } = await import('../src/modules/harnesses/recovery/processRegistry.js')
const { NativeResponseJournal } = await import('../src/modules/harnesses/recovery/responseJournal.js')
const { productionOperatorManagers } = await import('../src/modules/harnesses/operatorFiles/managers.js')

const connectionString = process.env.TEST_DATABASE_URL
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Valid, checksummed 1x1 PNG. The real image validation/preparation code reads it.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQMnb5DwACrQGZOt75egAAAABJRU5ErkJggg==', 'base64')
const cases: Array<{ name: string; filename: string; mediaType: FileMediaType; bytes: Buffer }> = [
  { name: 'attachment-only Markdown', filename: 'notes.md', mediaType: 'text/markdown', bytes: Buffer.from('# Pinned Operator document\n') },
  { name: 'image', filename: 'pixel.png', mediaType: 'image/png', bytes: image },
]
async function paths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? paths(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}

// Same constructor used by buildProductionApp; no alternate manager resolver or
// fake attachment admission is supplied by these sends.
describe.skipIf(!connectionString || process.platform === 'win32')('AF-02 production Operator native file delivery', () => {
  let schema: string, admin: pg.Pool, pool: pg.Pool, f: Fixture, config: ApiConfig, vault: string
  let app: ReturnType<typeof Fastify>
  let files: ReturnType<typeof registerProductionFileStorage>
  let tools: ReturnType<typeof productionFileTools>
  let operators: InstanceType<typeof PostgresOperatorRepository>
  let repository: InstanceType<typeof PostgresOperatorConversationRepository>
  let authority: InstanceType<typeof PostgresOperatorChatAuthority>
  let chat: InstanceType<typeof OperatorChatService>
  let owner: ManagementPrincipal
  let setup: ReturnType<typeof vi.spyOn>, prepare: ReturnType<typeof vi.spyOn>
  const issued: Array<{ context: FileToolContext; token: string }> = []
  const managers = new Map<string, NativeHarnessSessionManager>()

  beforeEach(async () => {
    const database = new URL(connectionString!)
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
      || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests.')
    schema = `af02_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString })
    await admin.query(`create schema "${schema}"`)
    pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    f = await fileRuntimeFixture()
    vault = await mkdtemp(join(process.cwd(), '.af02-vault-'))
    await writeFile(join(f.directory, 'file-turn'), '')
    // Audit key presence only, not credential values. The fixture's worker
    // default is absent because the actual Operator service supplies its input.
    const binary = await readFile(f.binary, 'utf8')
    const seam = "const agent = process.env.TEST_AGENT_ID || 'agent-a'"
    assert.equal(binary.split(seam).length, 2)
    await writeFile(f.binary, binary.replace(seam,
      `log({ af02CredentialKeys: Object.keys(process.env).filter((key) => /GRAPHQL.*(?:TOKEN|CREDENTIAL)/.test(key) && key !== 'GRAPHQL_HEAVY_JOB_TOKEN') })\n${seam}`))
    config = { host: '127.0.0.1', port: 4100, readinessTimeoutMs: 2000,
      database: { connectionString: connectionString!, maxConnections: 4, connectionTimeoutMs: 2000, queryTimeoutMs: 5000 },
      checkpoints: { schema: 'langgraph' }, workspaceStorageRoot: join(f.directory, 'projects'), fileStorageRoot: vault,
      harnesses: { workspaceRoot: join(f.directory, 'runtime'), codexBinary: f.binary, openCodeBinary: 'protocol-fixture', timeoutMs: 10000 } }
    const cwd = join(config.harnesses.workspaceRoot, 'operator')
    await mkdir(cwd, { recursive: true })
    await mkdir(config.workspaceStorageRoot!, { recursive: true })
    app = Fastify({ logger: false })
    files = registerProductionFileStorage(app, pool, config)
    await app.ready()
    tools = productionFileTools(app)
    const access = new PostgresAccessService(pool)
    owner = (await access.issue({ name: 'AF-02 owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 600000) })).principal
    operators = new PostgresOperatorRepository(pool)
    repository = new PostgresOperatorConversationRepository(pool)
    authority = new PostgresOperatorChatAuthority(pool, access, new NativeRollout({ NODE_ENV: 'test', HOST: '127.0.0.1' }), cwd, 'http://127.0.0.1:4100/mcp')
    setup = vi.spyOn(authority, 'setup')
    prepare = vi.spyOn(authority, 'prepare')
    const resolve = productionOperatorManagers({ app: () => app, pool, config, workingDirectory: cwd,
      endpointHost: '127.0.0.1', appMcpEndpoint: 'http://127.0.0.1:4100/mcp', managers,
      processRegistry: new NativeProcessRegistry(join(f.directory, 'processes')),
      responseJournal: new NativeResponseJournal(join(f.directory, 'responses')) })
    chat = new OperatorChatService(repository, operators, resolve, cwd, authority)
    const issue = tools.sessions.issueForAcceptedSession.bind(tools.sessions)
    vi.spyOn(tools.sessions, 'issueForAcceptedSession').mockImplementation(async (context, expiry, transport) => {
      // Issuance is forbidden until BOTH conversation ACK and original message
      // binding are durable. A callback failure must never issue a file token.
      const row = (await pool.query(`select c.active_native_turn_id,t.native_turn_id,t.message_id
        from operator_conversations c join operator_conversation_turns t on t.conversation_id=c.id
        where c.id=$1 and t.message_id=$2`, [context.scope.chat.conversationId, context.messageId])).rows[0]
      expect(row).toEqual({ active_native_turn_id: context.turnId, native_turn_id: context.turnId, message_id: context.messageId })
      const token = await issue(context, expiry, transport)
      issued.push({ context: structuredClone(context), token })
      return token
    })
  }, 30000)

  afterEach(async () => {
    try { await chat?.shutdown() } finally {
      try { await app?.close() } finally {
        await pool?.end()
        if (schema) await admin?.query(`drop schema if exists "${schema}" cascade`)
        await admin?.end()
        if (f) await rm(f.directory, { recursive: true, force: true })
        if (vault) await rm(vault, { recursive: true, force: true })
        managers.clear(); servers.length = 0; serverOptions.length = 0; issued.length = 0
        vi.restoreAllMocks()
      }
    }
  })

  for (const harness of ['codex', 'opencode'] as const) for (const item of cases) {
    it(`${harness}: ${item.name} reaches the native request exactly once with Operator-only authority`, async () => {
      const current = await operators.ensure()
      const native = harness === 'codex' ? input(f.directory).request.configuration.harness : openCodeConfiguration()
      await operators.update(native, current.operator.currentConfigurationVersionId)
      const conversation = await chat.create(owner)
      const target = { kind: 'operator' as const, conversationId: conversation.id }
      const uploadId = randomUUID()
      await files.allocate(owner, target, { requestId: uploadId, filename: item.filename, mediaType: item.mediaType,
        byteSize: item.bytes.length, sha256: digest(item.bytes) })
      await files.upload(owner, target, uploadId, Readable.from([item.bytes]))
      const ready = await files.finalize(owner, target, uploadId)
      const ref: MessageAttachmentRef = { fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId }
      const command = { requestId: randomUUID(), content: '', attachments: [ref] }
      const read = vi.spyOn(tools, 'readAccepted')
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(false)
      await until(async () => issued.length === 1, 10000)
      const context = issued[0]!.context
      expect(context.scope).toEqual({ kind: 'temporary', chat: {
        kind: 'operator', ownerPrincipalId: owner.id, operatorId: current.operator.id, conversationId: conversation.id,
      } })
      expect(context.ownerPrincipalId).toBe(owner.id)
      await expect(tools.list(issued[0]!.token, { scope: { kind: 'workspace_reference', workspaceId: 'foreign-workspace' } }))
        .rejects.toThrow()
      expect(context.messageId).toBeTruthy()
      expect(read.mock.calls.length).toBeGreaterThan(0)
      for (const [, request] of read.mock.calls) expect(request).toMatchObject(ref)
      expect(setup).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
      expect((await pool.query('select count(*)::int as count from operator_chat_credentials')).rows[0].count).toBe(0)
      const nativeSessionId = context.nativeSessionId
      let prompt: string, deliveredImage: string | undefined
      if (harness === 'codex') {
        const wire = (await calls(f.directory)).map((entry) => entry.wire as { method?: string; params?: Record<string, unknown> } | undefined)
        const turns = wire.filter((entry) => entry?.method === 'turn/start')
        expect(turns).toHaveLength(1)
        const parts = turns[0]!.params!.input as Array<{ type: string; text?: string; path?: string }>
        prompt = parts[0]!.text!
        deliveredImage = parts.find((part) => part.type === 'localImage')?.path
        const audit = await calls(f.directory)
        const environments = audit.filter((entry) => 'af02CredentialKeys' in entry)
        expect(environments.length).toBeGreaterThan(0)
        expect(environments.every((entry) => (entry.af02CredentialKeys as unknown[]).length === 0)).toBe(true)
        const thread = wire.find((entry) => entry?.method === 'thread/start')!
        expect(thread.params!.dynamicTools).toBeInstanceOf(Array)
        expect(audit.some((entry) => Array.isArray(entry.cli)
          && (entry.cli as string[]).some((arg) => /^mcp_servers\..+\.enabled=false$/.test(arg)))).toBe(true)
      } else {
        const server = servers[0]!
        const turns = server.calls.filter((call) => call.path.includes('/prompt_async'))
        expect(turns).toHaveLength(1)
        const parts = turns[0]!.body!.parts as Array<{ type: string; text?: string; url?: string; mime?: string }>
        prompt = parts[0]!.text!
        const part = parts.find((value) => value.type === 'file')
        if (part) { expect(part.mime).toBe(item.mediaType); deliveredImage = fileURLToPath(part.url!) }
        expect(serverOptions[0]!.appMcpAccess).toBe('none')
        expect(serverOptions[0]!.credentialEnvironmentVariable).toBeUndefined()
        for (const environment of server.restartEnvironments) expect(environment.variables).toEqual({})
        expect(JSON.stringify(turns[0]!.body!.system ?? '')).not.toContain('Attached files')
      }
      expect(prompt).toContain(item.filename)
      expect(prompt).not.toContain(config.fileStorageRoot!)
      expect(prompt).not.toContain('GRAPHQL_MCP_TOKEN')
      expect(prompt).not.toContain(issued[0]!.token)
      // Find the immutable original, not a model-selected/API-storage path.
      const hostFiles = await paths(join(config.harnesses.workspaceRoot, harness === 'codex' ? 'codex-chat-files' : 'chat-files'))
      const original = (await Promise.all(hostFiles.map(async (path) => ({ path, bytes: await readFile(path) }))))
        .find((file) => digest(file.bytes) === ready.value.revision.sha256)
      expect(original).toBeDefined()
      expect(prompt).toContain(original!.path)
      if (item.mediaType.startsWith('image/')) {
        expect(deliveredImage).toBeTruthy()
        expect((await readFile(deliveredImage!)).length).toBeGreaterThan(0)
      } else expect(deliveredImage).toBeUndefined()
      const readsBeforeReplay = read.mock.calls.length
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(true)
      expect((await chat.send(conversation.id, { ...command, recovery: 'receipt' }, owner)).replayed).toBe(true)
      expect(issued).toHaveLength(1)
      expect(read.mock.calls).toHaveLength(readsBeforeReplay)
      if (harness === 'codex') await finish(f.directory, nativeSessionId)
      else servers[0]!.complete(nativeCorrelation(conversation.id, command.requestId), 'done', nativeSessionId)
      await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
      await until(async () => managers.size === 0, 10000)
      await expect(tools.sessions.authenticate(issued[0]!.token)).rejects.toThrow()
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(true)
      expect((await chat.send(conversation.id, { ...command, recovery: 'receipt' }, owner)).replayed).toBe(true)
      expect(issued).toHaveLength(1)
      expect(read.mock.calls).toHaveLength(readsBeforeReplay)
      if (harness === 'codex') expect((await calls(f.directory)).filter((entry) =>
        (entry.wire as { method?: string } | undefined)?.method === 'turn/start')).toHaveLength(1)
      else expect(servers.flatMap((server) => server.calls).filter((call) => call.path.includes('/prompt_async'))).toHaveLength(1)
      expect((await chat.get(conversation.id, owner)).messages.filter((message) => message.role === 'user')).toHaveLength(1)
    }, 30000)
  }
  it('preserves the management MCP setup requirement for text-only Operator turns', async () => {
    const current = await operators.ensure()
    await operators.update(openCodeConfiguration(), current.operator.currentConfigurationVersionId)
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Manage the app.' }, owner)
    // This fixture deliberately has management MCP disabled. A text-only turn
    // must take the old setup/prepare path and fail, not bypass it as file chat.
    await until(async () => (await chat.get(conversation.id, owner)).turnState === 'error', 10000)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(setup).toHaveBeenCalledTimes(1)
    expect(serverOptions[0]!.appMcpAccess).toBeUndefined()
    expect(serverOptions[0]!.credentialEnvironmentVariable).toBe('GRAPHQL_MCP_TOKEN')
    expect(issued).toHaveLength(0)
    expect(servers.flatMap((server) => server.calls).some((call) => call.path.includes('/prompt_async'))).toBe(false)
  }, 30000)

})
