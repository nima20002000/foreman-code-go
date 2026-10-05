import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, type NativeHarnessEvent,
  type NativeSessionReference } from '@graphql/contracts'
import { ManagedWorkspaceCommandResultSchema } from '@graphql/contracts/management'
import { SavedManagedWorkflowSchema } from '@graphql/contracts/wave25'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1' && Boolean(process.env.TEST_DATABASE_URL)
const binaries = harnessBinaries(process.env)

function managementCallCompleted(event: NativeHarnessEvent, harness: 'codex' | 'opencode', name: string) {
  if (harness === 'codex') {
    const item = event.payload.item as Record<string, unknown> | undefined
    return event.type === 'item.completed' && item?.type === 'mcpToolCall'
      && item.server === 'graphql' && item.tool === name
  }
  const part = event.payload.part as Record<string, unknown> | undefined
  const state = part?.state as Record<string, unknown> | undefined
  return event.type === 'message.part.updated' && part?.type === 'tool'
    && part.tool === `graphql_${name}` && ['completed', 'error'].includes(String(state?.status))
}

describe.skipIf(!enabled)('installed native Operator management MCP', () => {
  for (const harness of ['codex', 'opencode'] as const) {
    it.each([false, true])(`${harness}: reads a spec and applies live management scope (denied: %s)`, async denied => {
      const f = await workspaceMcpFixture()
      let manager: NativeHarnessSessionManager | undefined
      let session: NativeSessionReference | undefined
      try {
        f.services.workflows = new WorkflowManagementService(f.pool, f.commands)
        const workspace = await callWorkspaceTool(f.owner.client, 'workspace_create',
          ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Native management target' })
        const foreign = await callWorkspaceTool(f.owner.client, 'workspace_create',
          ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Other native project' })
        const credential = await f.access.issue({ name: 'Native management caller', audience: 'operator',
          grants: [{ actions: ['workflows:create', 'workflows:read'],
            scope: { workspaceIds: [denied ? foreign.value.workspace.id : workspace.value.workspace.id] } }],
          expiresAt: new Date(Date.now() + 600000) })
        const caller = { ...credential, client: await f.connect(credential.token) }
        const operators = new PostgresOperatorRepository(f.pool)
        const current = await operators.ensure()
        const native = harness === 'codex'
          ? { harness: 'codex' as const, model: process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna',
            reasoningEffort: 'low' as const, sandbox: 'read-only' as const, serviceTier: 'standard' as const }
          : { harness: 'opencode' as const, model: process.env.OPENCODE_TEST_MODEL ?? 'opencode-go/gpt-5.6-luna',
            variant: 'low', nativeAgent: 'plan', thinking: false, autoApprove: false,
            advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION, permissionRules: [
              { permission: '*', pattern: '*', effect: 'deny' as const },
              { permission: 'read', pattern: '*', effect: 'allow' as const },
              { permission: 'graphql_*', pattern: '*', effect: 'allow' as const },
            ], mcp: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION.mcp, serverEnabled: { graphql: true } } } }
        const { configuration } = await operators.update(native, current.configuration.id)
        const directory = join(f.parentPath, 'native-runtime')
        await mkdir(directory)
        const endpoint = new URL('/mcp', f.address).toString()
        await mkdir(join(directory, '.codex'))
        await writeFile(join(directory, '.codex', 'config.toml'), [
          '[mcp_servers.graphql]', `url = ${JSON.stringify(endpoint)}`,
          'bearer_token_env_var = "GRAPHQL_MCP_TOKEN"', '',
        ].join('\n'))
        await writeFile(join(directory, 'opencode.json'), JSON.stringify({ mcp: { graphql: {
          type: 'remote', url: endpoint, enabled: true,
          headers: { Authorization: 'Bearer {env:GRAPHQL_MCP_TOKEN}' },
        } } }))
        const command = { workspaceId: workspace.value.workspace.id, commandId: randomUUID(),
          name: `Native spec ${randomUUID()}` }
        const spec = `Call the graphql MCP workflow_create tool exactly once with ${JSON.stringify(command)}.\n`
          + 'If creation succeeds, call workflow_get with its workspaceId and workflowId.\n'
          + 'If access is denied, report ACCESS_DENIED and stop. Do not change any files.\n'
        const specPath = join(directory, 'spec.md')
        await writeFile(specPath, spec)
        manager = harness === 'codex'
          ? new CodexAppServerSessionManager(binaries.codexBinary)
          : new OpenCodeNativeSessionManager({ ownerAgentId: configuration.operatorId,
            expectedAppMcpEndpoint: endpoint, server: new ManagedOpenCodeServer({
              binary: binaries.openCodeBinary, workingDirectory: directory, ownerAgentId: configuration.operatorId,
              credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
              ...(native.harness === 'opencode' ? { advancedConfiguration: native.advanced } : {}),
            }) })
        const correlation = `native-management:${randomUUID()}`
        session = await manager.createSession({ kind: 'operator', configuration, workingDirectory: directory,
          correlationId: correlation,
          environment: { agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: caller.token } } })
        const signal = AbortSignal.timeout(180000)
        const nativeEvents: NativeHarnessEvent[] = []
        for await (const event of manager.startTurn(session, {
          clientCorrelationId: correlation,
          prompt: `Read ${specPath} with the native read tool and follow its instructions using graphql MCP.`,
        }, signal)) nativeEvents.push(event)
        expect((await manager.reconcile(session, correlation, signal)).terminalResult?.outcome).toBe('succeeded')
        expect(nativeEvents.some(event => managementCallCompleted(event, harness, 'workflow_create'))).toBe(true)
        if (!denied) expect(nativeEvents.some(event => managementCallCompleted(event, harness, 'workflow_get'))).toBe(true)
        expect(await readFile(specPath, 'utf8')).toBe(spec)
        const workflows = await f.pool.query<{ id: string }>('select id from workflows where workspace_id=$1',
          [workspace.value.workspace.id])
        const audits = await f.pool.query<{ action: string; outcome: string }>(
          'select action,outcome from management_audit where principal_id=$1 and source=$2', [caller.principal.id, 'mcp'])
        if (denied) {
          expect(workflows.rows).toEqual([])
          expect(audits.rows).toContainEqual({ action: 'workflow_create', outcome: 'denied' })
          expect((await f.pool.query('select command_id from management_command_receipts where command_id=$1',
            [command.commandId])).rows).toEqual([])
        } else {
          expect(workflows.rows).toHaveLength(1)
          expect(audits.rows).toContainEqual({ action: 'workflow.create', outcome: 'succeeded' })
          const readback = await callWorkspaceTool(caller.client, 'workflow_get', SavedManagedWorkflowSchema,
            { workspaceId: workspace.value.workspace.id, workflowId: workflows.rows[0]!.id })
          expect(readback.workflow.name).toBe(command.name)
          const fresh = new WorkflowManagementService(f.pool, f.commands)
          expect(await fresh.get(caller.principal, workspace.value.workspace.id, workflows.rows[0]!.id)).toEqual(readback)
          expect((await f.pool.query('select result from management_command_receipts where command_id=$1',
            [command.commandId])).rows).toEqual([{ result: readback }])
        }
      } finally {
        try { if (session) await manager?.close(session) }
        finally {
          try { await manager?.dispose?.() }
          finally { await f.close() }
        }
      }
    }, 240000)
  }
})
