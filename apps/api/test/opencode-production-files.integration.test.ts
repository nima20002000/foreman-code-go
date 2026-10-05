import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentChatContext, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { loadConfig } from '../src/config.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { prepareOpenCodeChatFiles, type OpenCodeChatFiles, type OpenCodeManagedFileTurn } from '../src/modules/harnesses/opencodeFiles/chat.js'
import { productionOpenCodeChatFiles } from '../src/modules/harnesses/opencodeFiles/production.js'
import { resolveOpenCodeFileAdmission } from '../src/modules/harnesses/opencodeFiles/postgres.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import type { OpenCodeServerController } from '../src/modules/harnesses/opencodeTransport.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { configuration, request } from './opencode-fixtures.js'

describe.skipIf(!postgresEnabled)('production OpenCode file host', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let directory: string

  beforeAll(async () => {
    database = await agent3Database()
    directory = await mkdtemp(join(homedir(), '.opencode-production-files-'))
  })
  afterAll(async () => {
    try {
      if (directory) await rm(directory, { recursive: true, force: true })
    } finally {
      await database?.close()
    }
  })

  // Native protocol, namespace checks, disk bytes, admissions and file services
  // use the production implementations. No model inference is needed to prepare inputs.
  async function fixture(attachments: 'none' | 'image', recovery?: 'replacement' | 'api_crash' | 'native_replacement') {
    const attach = attachments === 'image'
    const root = join(directory, randomUUID())
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    const config = loadConfig({ DATABASE_URL: database.pool.options.connectionString,
      FILE_STORAGE_ROOT: join(root, 'vault'), HARNESS_WORKSPACE_ROOT: workspace })
    const harness = { ...configuration(), model: process.env.TEST_OPENCODE_MODEL ?? configuration().model }
    const source = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    const seeded = await seedAgent3(database.pool, workspace, { ...source,
      configurations: source.configurations.map((value) => ({ ...value, harness })),
    }, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const acceptedConfiguration = seeded.configurations.find((value) => value.agentId === node.agentId)!
    const context: AgentChatContext = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const access = new PostgresAccessService(database.pool)
    const sender = await access.issue({ name: 'OpenCode file sender', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [context.workspaceId] } }] })
    const conversations = new PostgresAgentChatRepository(database.pool)
    const key = agentChatKey(context)
    const initialRequest: SendAgentChatMessageRequest = { requestId: randomUUID(), content: 'establish conversation',
      context: { workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId },
      intent: 'next_turn', expectedConversationId: null }
    const initial = await conversations.admit({ key, context, request: initialRequest, delivery: 'queued',
      ownerPrincipalId: sender.principal.id, create: { context, agentConfigurationVersionId: acceptedConfiguration.id,
        harness: 'opencode', origin: { kind: 'fresh' }, workingDirectory: workspace, runtimeDirectory: workspace } })
    await conversations.cancelQueued(initial.conversationId, initialRequest.requestId)
    const app = Fastify({ logger: false })
    const files = registerProductionFileStorage(app, database.pool, config)
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('Expected the local API listener.')
    config.port = address.port
    let runtime: OpenCodeChatFiles | undefined
    let server: OpenCodeServerController | undefined
    let turn: OpenCodeManagedFileTurn | undefined
    const factories = new NativeHarnessFactories({ ...config.harnesses, openCodeFileStorageRoot: files.bytes.root })
    const allocation = factories.allocate({ harness: 'opencode', role: 'agent-chat', workingDirectory: workspace,
      ownerAgentId: node.agentId, appMcpAccess: 'none',
      chatFiles: (native) => {
        server = native
        runtime = productionOpenCodeChatFiles(() => app, database.pool, config, initial.conversationId, native, '127.0.0.1')
        return runtime
      } })
    if (allocation.harness !== 'opencode') throw new Error('Expected the OpenCode allocation.')
    let failure: unknown
    const cleanupErrors: unknown[] = []
    try {
      const input = { ...request(harness), configuration: acceptedConfiguration,
        workingDirectory: workspace, runtimeDirectory: workspace }
      const session = await allocation.manager.createSession({ request: input }, AbortSignal.timeout(30_000))
      await conversations.bindSession(initial.conversationId, session.providerVersion, session.nativeSessionId)
      const target = { kind: 'agent' as const, workspaceId: context.workspaceId, conversationId: initial.conversationId }
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQMnb5DwACrQGZOt75egAAAABJRU5ErkJggg==',
        'base64',
      )
      const uploadId = randomUUID()
      await files.allocate(sender.principal, target, { requestId: uploadId, filename: 'input.png', mediaType: 'image/png',
        byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      await files.upload(sender.principal, target, uploadId, Readable.from([bytes]))
      const uploaded = (await files.finalize(sender.principal, target, uploadId)).value
      const ref = { fileId: uploaded.file.fileId, revisionId: uploaded.revision.revisionId }
      const message: SendAgentChatMessageRequest = { ...initialRequest, requestId: randomUUID(), content: 'read the file',
        expectedConversationId: initial.conversationId, ...(attach ? { attachments: [ref] } : {}) }
      await conversations.admit({ key, context, request: message, delivery: 'queued', ownerPrincipalId: sender.principal.id })
      expect(await conversations.claim(initial.conversationId, message.requestId)).toBe(true)
      const correlation = agentChatCorrelation(initial.conversationId, message.requestId)
      const identity = { ownerAgentId: node.agentId, nativeSessionId: session.nativeSessionId,
        nativeTurnId: nativeMessageId(correlation), clientCorrelationId: correlation, directory: workspace, configuration: harness }
      if (!runtime || !server) throw new Error('Production file composition was not allocated.')
      turn = await prepareOpenCodeChatFiles(runtime, identity, server, 'foreman-code', AbortSignal.timeout(30_000))
      expect(turn).toBeDefined()
      expect(turn!.inputs.promptSuffix).toContain('files.')
      expect(turn!.inputs.imageParts).toHaveLength(attach ? 1 : 0)
      if (attach) {
        const part = turn!.inputs.imageParts[0]!
        expect(part).toMatchObject({ type: 'file', mime: 'image/png', filename: 'input.png' })
        expect(await readFile(fileURLToPath(part.url))).toEqual(bytes)
      }
      // Plain follow-ups retain tools for the existing reference without materializing it.
      expect((await files.list(sender.principal, target, { limit: 10 })).items.some((item) => item.file.fileId === ref.fileId))
        .toBe(true)
      await expect(prepareOpenCodeChatFiles(runtime, { ...identity, ownerAgentId: randomUUID() }, server,
        'foreman-code', AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: 'FILE_ADMISSION_MISMATCH' })
      await server.assertFileSourceIsolation!(files.bytes.root, AbortSignal.timeout(10_000))
      if (recovery === 'native_replacement') {
        await turn!.finish('definite_rejection', AbortSignal.timeout(10_000))
        turn = undefined
        const observer = allocation.manager.startTurn(session, { prompt: message.content,
          clientCorrelationId: correlation, onSubmitted: async () => {
            throw new Error('Observer detached after native submission.')
          } }, AbortSignal.timeout(30_000))[Symbol.asyncIterator]()
        await expect(observer.next()).rejects.toThrow('Observer detached after native submission.')
        const ownerRoot = server.ownedFileRoot!
        const retainedRoots = await readdir(ownerRoot)
        expect(retainedRoots).toHaveLength(1)
        const previousPid = server.nativePid
        await server.dispose()
        await allocation.manager.capabilities(AbortSignal.timeout(30_000))
        await allocation.manager.capabilities(AbortSignal.timeout(30_000))
        expect(server.nativePid).not.toBe(previousPid)
        expect(await readdir(ownerRoot)).toEqual([])
        expect(await readdir(join(files.bytes.root, 'opencode-file-cleanup'))).toEqual([])
        const stored = await server.request(`/session/${session.nativeSessionId}/message/${identity.nativeTurnId}`
          + `?directory=${encodeURIComponent(workspace)}`)
        expect(stored.status).toBe(200)
        expect((await stored.json() as { info: { id: string } }).info.id).toBe(identity.nativeTurnId)
      }
      if (recovery === 'api_crash') {
        const turnRoot = dirname(dirname(fileURLToPath(turn!.inputs.imageParts[0]!.url)))
        const admission = await resolveOpenCodeFileAdmission(database.pool, initial.conversationId, identity)
        if (!admission || !server.nativePid) throw new Error('Expected the admitted native file owner.')
        expect((await conversations.turn(initial.conversationId, message.requestId))?.nativeTurnId).toBeUndefined()
        await turn!.finish('definite_rejection', AbortSignal.timeout(10_000))
        turn = undefined
        const journalModule = new URL('../src/modules/harnesses/opencodeFiles/cleanupJournal.ts', import.meta.url).href
        const cleanupModule = new URL('../src/modules/harnesses/opencodeFiles/cleanup.ts', import.meta.url).href
        const program = `
          import { mkdir, writeFile } from 'node:fs/promises'
          import { OpenCodeFileCleanupJournal } from ${JSON.stringify(journalModule)}
          import { ownOpenCodeDirectory } from ${JSON.stringify(cleanupModule)}
          const [vault, root, nativePid, context] = process.argv.slice(1)
          await mkdir(root, { mode: 0o700 })
          await writeFile(root + '/input.png', 'unsubmitted input')
          new OpenCodeFileCleanupJournal(vault).register(await ownOpenCodeDirectory(root),
            Number(nativePid), JSON.parse(context))
          console.log('registered')
          setInterval(() => {}, 1000)
        `
        const crashedApi = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program,
          files.bytes.root, turnRoot, String(server.nativePid), JSON.stringify(admission.context)],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
        const exited = once(crashedApi, 'exit')
        try {
          const output = await Promise.race([
            once(crashedApi.stdout, 'data'),
            exited.then(() => { throw new Error('Crash fixture exited before registering its input.') }),
          ])
          expect(String(output[0])).toContain('registered')
          crashedApi.kill('SIGKILL')
          await exited
        } finally {
          if (crashedApi.exitCode === null && crashedApi.signalCode === null) crashedApi.kill('SIGKILL')
          await exited
        }
        await allocation.manager.dispose()
        const fresh = factories.allocate({ harness: 'opencode', role: 'agent-chat', workingDirectory: workspace,
          ownerAgentId: node.agentId, appMcpAccess: 'none',
          chatFiles: native => productionOpenCodeChatFiles(() => app, database.pool, config,
            initial.conversationId, native, '127.0.0.1') })
        try {
          await fresh.manager.capabilities(AbortSignal.timeout(30_000))
          await fresh.manager.capabilities(AbortSignal.timeout(30_000))
          await expect(readdir(turnRoot)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await readdir(join(files.bytes.root, 'opencode-file-cleanup'))).toEqual([])
          expect((await conversations.turn(initial.conversationId, message.requestId))?.nativeTurnId).toBeUndefined()
        } finally {
          await fresh.manager.dispose()
        }
      }
      if (recovery === 'replacement') {
        const turnRoot = dirname(dirname(fileURLToPath(turn!.inputs.imageParts[0]!.url)))
        await mkdir(join(turnRoot, 'extracted', 'nested'), { recursive: true })
        await writeFile(join(turnRoot, 'extracted', 'nested', 'leftover'), 'owned residue')
        const held = `${turnRoot}-held`
        await rename(turnRoot, held)
        await mkdir(turnRoot)
        await writeFile(join(turnRoot, 'foreign'), 'keep foreign bytes')
        await expect(turn!.finish('definite_rejection', AbortSignal.timeout(10_000))).rejects.toThrow()
        await allocation.manager.dispose()
        // The persisted journal now owns cleanup; the retired bridge must not remove recovered paths.
        turn = undefined
        const fresh = factories.allocate({ harness: 'opencode', role: 'agent-chat', workingDirectory: workspace,
          ownerAgentId: node.agentId, appMcpAccess: 'none',
          chatFiles: native => productionOpenCodeChatFiles(() => app, database.pool, config,
            initial.conversationId, native, '127.0.0.1') })
        try {
          await expect(fresh.manager.createSession({ request: input }, AbortSignal.timeout(30_000))).rejects.toThrow()
          expect(await readFile(join(turnRoot, 'foreign'), 'utf8')).toBe('keep foreign bytes')
          await rm(turnRoot, { recursive: true })
          await rename(held, turnRoot)
          await fresh.manager.createSession({ request: input }, AbortSignal.timeout(30_000))
          await expect(readFile(join(turnRoot, 'extracted', 'nested', 'leftover'))).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await readdir(join(files.bytes.root, 'opencode-file-cleanup'))).toEqual([])
          turn = undefined
        } finally {
          await fresh.manager.dispose()
        }
      }
    } catch (error) {
      failure = error
    } finally {
      const cleanup = [
        () => turn?.finish('definite_rejection', AbortSignal.timeout(10_000)),
        () => allocation.manager.dispose(),
        () => app.close(),
      ]
      for (const close of cleanup) {
        try {
          await close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
        'Production file fixture cleanup failed.', { cause: failure ?? cleanupErrors[0] })
    }
    if (failure !== undefined) throw failure
  }

  it('recovers deferred cleanup in a fresh native manager after confirmed closure and preserves replacement paths', async () => {
    await fixture('image', 'replacement')
  })
  it('reclaims prepared inputs after an abrupt API crash before native submission', async () => {
    await fixture('image', 'api_crash')
  })
  it('releases retained bridges once when replacing the native process in the same production manager', async () => {
    await fixture('image', 'native_replacement')
  })
  it('prepares plain chat with inherited references using an API-owned vault', async () => {
    await fixture('none')
  })
  it('prepares an attachment through the real production factory and isolated native host', async () => {
    await fixture('image')
  })
})
