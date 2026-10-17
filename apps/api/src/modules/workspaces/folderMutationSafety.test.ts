import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { agentChatKey, PostgresAgentChatRepository, type AgentConversationRow } from '../conversations/agentChatRepository.js'
import { HarnessDirectoryBrowser } from '../harnesses/directoryBrowser.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { WorkspaceStorageFolders } from './storageFolders.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const principal: ManagementPrincipal = {
  id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workspaces:read', 'workspaces:archive', 'workspace_locations:read', 'workspace_locations:provision'], scope: {} }],
}

/** In-memory SQL dependency with transaction-scoped locks; the services and filesystem are real. */
function database(path: string) {
  const context = { workspaceId: randomUUID(), workflowId: randomUUID(), workflowNodeId: randomUUID(), agentId: randomUUID() }
  const now = new Date()
  const conversation: AgentConversationRow = {
    id: randomUUID(), agent_key: agentChatKey(context), workspace_id: context.workspaceId,
    workflow_id: context.workflowId, workflow_node_id: context.workflowNodeId, agent_id: context.agentId,
    agent_configuration_version_id: randomUUID(), origin_run_id: null, origin_execution_id: null,
    harness: 'codex', provider_version: 'fixture', native_session_id: 'session', active_request_id: null,
    active_native_turn_id: null, cancel_requested: false, turn_state: 'idle', last_error: null,
    revision: 1, pending_interaction: null, last_result: null,
    record: { origin: { kind: 'fresh' }, workingDirectory: path, runtimeDirectory: '' },
    created_at: now, updated_at: now,
  }
  const state = {
    conversation, context, hostKind: 'main', imports: [] as Array<{ path: string }>,
    messages: [] as unknown[][], turns: [] as Record<string, unknown>[],
    receipts: [] as Array<{ operation: string; commandId: string; result: unknown }>,
    readChatReferences: async () => {},
  }
  const locks = new Map<string, { owner: object; done: ReturnType<typeof deferred> }>()
  const blocked = deferred()
  function connect() {
    const owner = {}
    const held = new Set<string>()
    const releaseLocks = () => {
      for (const key of held) {
        locks.get(key)!.done.resolve(undefined)
        locks.delete(key)
      }
      held.clear()
    }
    const query = async (text: string, values: unknown[] = []) => {
      if (text.includes('pg_advisory_xact_lock')) {
        const key = String(values[0])
        while (locks.has(key) && locks.get(key)!.owner !== owner) {
          blocked.resolve()
          await locks.get(key)!.done.promise
        }
        locks.set(key, locks.get(key) ?? { owner, done: deferred() })
        held.add(key)
        return result([])
      }
      if (text === 'commit' || text === 'rollback') {
        releaseLocks()
        return result([])
      }
      return execute(text, values)
    }
    return { query, release: releaseLocks }
  }
  async function execute(text: string, values: unknown[]) {
    if (text.includes('with continuing_runs')) return result([])
    if (text.includes('select execution_location')) return result([])
    if (text.includes('from workspace_repository_imports')) return result(state.imports)
    if (text.includes("c.record->>'workingDirectory'")) {
      if (text.includes('active_request_id is not null')) {
        const rows = state.turns.length && state.hostKind === 'main' ? [{ path }] : []
        await state.readChatReferences()
        return result(rows)
      }
      return result([{ path, host_kind: state.hostKind }])
    }
    if (text.includes('select * from operator_conversations')) return result([conversation])
    if (text.includes('select archived_at from workspaces')) return result([{ archived_at: null }])
    if (text.includes('select count(*)::text as count')) return result([{ count: String(state.turns.length) }])
    if (text.includes('select record from conversation_session_controls')) return result([])
    if (text.includes('insert into operator_conversation_messages')) {
      state.messages.push(values)
      return result([])
    }
    if (text.includes('insert into operator_conversation_turns')) {
      const row = {
        request_id: values[1], turn_sequence: String(state.turns.length + 1), payload: JSON.parse(String(values[2])),
        input_hash: values[3], intent: values[4], delivery: values[5], message_id: values[6],
        target_native_turn_id: values[7], native_turn_id: null, delivery_error: null,
        created_at: now, updated_at: now, started_at: null,
      }
      state.turns.push(row)
      return result([row])
    }
    if (text.includes('from operator_conversation_turns')) {
      return result(state.turns.filter(turn => turn.request_id === values[1]))
    }
    if (text.includes('insert into management_command_receipts')) {
      state.receipts.push({ operation: String(values[1]), commandId: String(values[2]), result: JSON.parse(String(values[5])) })
      return result([])
    }
    if (text.includes('from management_command_receipts') && text.includes("operation='workspace.folder.create'")) {
      return result(state.receipts.filter(receipt => receipt.operation === 'workspace.folder.create' && receipt.commandId === values[1]))
    }
    return result([])
  }
  const pool = { connect, query: (text: string, values: unknown[] = []) => execute(text, values) } as unknown as pg.Pool
  return { ...state, state, pool, blocked }
}

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length }
}

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'folder-mutation-'))
  roots.push(root)
  const path = join(root, 'retained')
  await mkdir(path)
  const db = database(path)
  const folders = new WorkspaceStorageFolders(db.pool, new PostgresCommandCoordinator(db.pool), root)
  const browser = new HarnessDirectoryBrowser([root], db.pool)
  const repository = new PostgresAgentChatRepository(db.pool)
  const send = (requestId = randomUUID(), assertCurrent?: (client: pg.PoolClient) => Promise<void>) => repository.admit({
    key: db.conversation.agent_key, context: db.context, delivery: 'queued',
    ...(assertCurrent ? { assertCurrent } : {}),
    request: { requestId, content: 'Continue working', intent: 'next_turn', expectedConversationId: db.conversation.id,
      context: { workflowId: db.context.workflowId, workflowNodeId: db.context.workflowNodeId, agentId: db.context.agentId } },
  })
  const remove = async () => {
    const folder = (await folders.list(principal, {})).items[0]!
    return folders.delete(principal, 'http', { path, expectedIdentity: folder.identity, commandId: randomUUID() })
  }
  return { ...db, root, path, folders, browser, send, remove }
}

it('rejects a retained-folder follow-up when recursive removal wins admission', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'work.txt'), 'retained work')
  const folder = (await f.folders.list(principal, {})).items[0]!
  const checked = deferred()
  const release = deferred()
  f.state.readChatReferences = async () => {
    checked.resolve()
    await release.promise
  }
  const deleting = f.folders.delete(principal, 'http', {
    path: f.path, expectedIdentity: folder.identity, commandId: randomUUID(),
  })
  await checked.promise
  const sending = f.send().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await Promise.race([sending, f.blocked.promise])
  } finally {
    release.resolve()
  }
  await deleting
  expect(await sending).toMatchObject({ error: { code: 'AGENT_CHAT_DIRECTORY_UNAVAILABLE' } })
  expect(f.state.turns).toHaveLength(0)
  expect(f.state.messages).toHaveLength(0)
  await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps retained-folder files when follow-up admission wins recursive removal', async () => {
  const f = await fixture()
  await writeFile(join(f.path, 'work.txt'), 'retained work')
  const entered = deferred()
  const release = deferred()
  const sending = f.send(randomUUID(), async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const deleting = f.remove().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await Promise.race([deleting, f.blocked.promise])
  } finally {
    release.resolve()
  }
  expect(await sending).toMatchObject({ turn: { delivery: 'queued' } })
  expect(await deleting).toMatchObject({ error: { code: 'DIRECTORY_IN_USE' } })
  expect(f.state.turns).toHaveLength(1)
  expect(await readFile(join(f.path, 'work.txt'), 'utf8')).toBe('retained work')
})

it('reads back a completed request after its retained directory is removed', async () => {
  const f = await fixture()
  const requestId = randomUUID()
  const admitted = await f.send(requestId)
  await rm(f.path, { recursive: true })
  expect(await f.send(requestId)).toMatchObject({ replayed: true, turn: admitted.turn })
  expect(f.state.turns).toHaveLength(1)
})

it('does not check a device conversation directory on the application host', async () => {
  const f = await fixture()
  f.state.hostKind = 'device'
  await rm(f.path, { recursive: true })
  expect(await f.send()).toMatchObject({ turn: { delivery: 'queued' } })
})

it.each(['rename', 'delete', 'undo'] as const)('protects an unfinished import from folder-picker %s', async action => {
  const f = await fixture()
  const creationCommandId = randomUUID()
  const folder = (await f.browser.create(principal, 'http', {
    parentPath: f.root, name: 'import-container', commandId: creationCommandId,
  })).value
  f.state.imports.push({ path: folder.path })
  if (action === 'delete') {
    expect(await f.browser.deleteFolders(principal, 'http', { paths: [folder.path], commandId: randomUUID() }))
      .toMatchObject({ value: { deleted: [], failed: [{ path: folder.path, message: expect.any(String) }] } })
  } else if (action === 'rename') {
    await expect(f.browser.renameCreated(principal, 'http', { path: folder.path, name: 'renamed', commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  } else {
    await expect(f.browser.undoCreated(principal, 'http', { creationCommandId, commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  }
  expect((await lstat(folder.path)).isDirectory()).toBe(true)
  f.state.imports.length = 0
  expect(await f.browser.deleteFolders(principal, 'http', { paths: [folder.path], commandId: randomUUID() }))
    .toMatchObject({ value: { deleted: [folder.path], failed: [] } })
})

it.each(['create', 'rename'] as const)('keeps a reserved import destination available during folder %s', async action => {
  const f = await fixture()
  const destination = join(f.root, 'import-container')
  f.state.imports.push({ path: destination })
  const mutation = action === 'create'
    ? f.browser.create(principal, 'http', { parentPath: f.root, name: 'import-container', commandId: randomUUID() })
    : f.browser.renameCreated(principal, 'http', { path: f.path, name: 'import-container', commandId: randomUUID() })
  await expect(mutation).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await lstat(f.path)).isDirectory()).toBe(true)
})
