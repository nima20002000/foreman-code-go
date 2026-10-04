import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type HarnessExecutionRequest, type NativeHarnessEvent } from '@foreman-code/contracts'
import type { WorkflowNativeSessionStart } from '../../src/modules/harnesses/port.js'
import { isQualifiedCodexVersion, type QualifiedCodex } from '../../src/modules/harnesses/codexProtocol.js'
import type { CodexProtocol, JsonObject } from '../../src/modules/harnesses/codexStdioTransport.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { runCommand } from '../../src/modules/harnesses/process.js'

export interface Fixture { directory: string; binary: string }
export async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-codex-regression-'))
  const binary = join(directory, 'codex')
  const source = await readFile(new URL('./codex-app-server.cjs', import.meta.url), 'utf8')
  await writeFile(binary, `#!${process.execPath}\n${source}`)
  await chmod(binary, 0o755)
  return { directory, binary }
}
export function input(directory: string, agentId = 'agent-a'): WorkflowNativeSessionStart {
  const request: HarnessExecutionRequest = {
    executionId: `execution-${agentId}`, runId: 'run-1', workspaceId: 'workspace-1', workflowNodeId: 'node-1',
    workingDirectory: directory, runtimeDirectory: directory, input: {},
    configuration: {
      id: `configuration-${agentId}`, workspaceId: 'workspace-1', agentId, version: 1,
      prompt: { system: 'Test the native transport.' }, assignedSkills: [],
      harness: {
        harness: 'codex', model: 'test-model', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard',
        advanced: structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION),
      },
      contentHash: 'sha256:fixture', createdAt: '2026-09-16T00:00:00.000Z',
    },
  }
  return { request, environment: { agentId, variables: { TEST_AGENT_ID: agentId, GRAPHQL_MCP_TOKEN: `token-${agentId}` } } }
}
export async function calls(directory: string): Promise<JsonObject[]> {
  try { return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonObject) }
  catch { return [] }
}
export async function emit(directory: string, value: unknown, agentId = 'agent-a'): Promise<void> {
  await appendFile(join(directory, `inbox-${agentId}.jsonl`), JSON.stringify(value) + '\n')
}
export async function state(directory: string, sessionId: string): Promise<{ id: string; turns: JsonObject[]; settings: JsonObject }> {
  return JSON.parse(await readFile(join(directory, `state-${sessionId}.json`), 'utf8')) as { id: string; turns: JsonObject[]; settings: JsonObject }
}
export async function finish(directory: string, sessionId: string, answer = 'correct-answer'): Promise<void> {
  const current = await state(directory, sessionId)
  const turn = current.turns.at(-1)!
  await emit(directory, { method: 'turn/completed', params: { threadId: sessionId, turn: {
    ...turn, status: 'completed', completedAt: 2,
    items: [{ type: 'agentMessage', id: 'final-item', text: answer, phase: 'final_answer' }],
  } } })
}
export async function until<T>(probe: () => Promise<T | undefined | false>, timeout = 5_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for fixture state.')
}
export function collect(iterator: AsyncIterable<NativeHarnessEvent>): Promise<NativeHarnessEvent[]> {
  const result = (async () => { const events: NativeHarnessEvent[] = []; for await (const event of iterator) events.push(event); return events })()
  void result.catch(() => undefined)
  return result
}
export function errorCode(error: unknown): string | undefined {
  return error instanceof HarnessExecutionError ? error.result.error?.code : undefined
}
export function nativeTurn(value: unknown): void {
  assert(value && typeof value === 'object')
  const turn = value as JsonObject
  assert.equal(typeof turn.id, 'string')
  assert(Array.isArray(turn.items))
  assert(['full', 'summary', 'notLoaded'].includes(String(turn.itemsView)))
  assert(['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status)))
  for (const field of ['error', 'startedAt', 'completedAt', 'durationMs']) assert(Object.hasOwn(turn, field))
}
/** Test double for schema qualification only. Real implementation tests are separate. */
export const fixtureProtocol: CodexProtocol = {
  request() {}, serverResponse() {},
  response(method, value) {
    assert(value && typeof value === 'object')
    if (method === 'turn/start') nativeTurn((value as JsonObject).turn)
  },
  serverRequest(message) { assert(message.params && typeof message.params.threadId === 'string') },
  notification(message) {
    assert(message.params && typeof message.params === 'object')
    const params = message.params as JsonObject
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      assert.equal(typeof params.threadId, 'string'); nativeTurn(params.turn)
    }
  },
}
export async function fixtureQualification(
  binary: string, expectedVersion: string | undefined, cwd: string, environment: NodeJS.ProcessEnv,
  requireAuthentication: boolean, signal?: AbortSignal,
): Promise<QualifiedCodex> {
  const version = await runCommand(binary, ['--version'], cwd, signal, environment)
  const installed = version.stdout.trim()
  if (version.exitCode !== 0 || (expectedVersion === undefined ? !isQualifiedCodexVersion(installed) : installed !== expectedVersion)) {
    throw new HarnessExecutionError('CODEX_APP_SERVER_VERSION_UNQUALIFIED', 'Fixture version rejected.')
  }
  if (requireAuthentication) {
    const auth = await runCommand(binary, ['login', 'status'], cwd, signal, environment)
    if (auth.exitCode !== 0) throw new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Fixture authentication rejected.')
  }
  return {
    binary, identity: 'test-double', providerVersion: installed, protocol: fixtureProtocol,
    schemaManifestSha256: 'test-double-not-installed-evidence', stableSchemaGitBlob: 'test-double', referenceSchemaManifestSha256: 'test-double',
  }
}
