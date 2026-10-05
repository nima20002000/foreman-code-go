import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type HarnessExecutionRequest, type PendingNativeInteraction } from '@foreman-code/contracts'
import { describe, it } from 'vitest'

import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { CodexRpcError, isObject } from '../src/modules/harnesses/codexStdioTransport.js'
// Workflow and live acceptance share the native session manager.

const enabled = process.env.RUN_CODEX_APP_SERVER_TESTS === '1'
const binary = process.env.CODEX_BINARY ?? 'codex'
function outputText(output: unknown): string { return isObject(output) && typeof output.text === 'string' ? output.text : '' }
function request(directory: string): HarnessExecutionRequest {
  return {
    executionId: 'nim2598-live-execution', runId: 'nim2598-live-run', workspaceId: 'nim2598-live-workspace',
    workflowNodeId: 'nim2598-live-node', workingDirectory: directory, runtimeDirectory: directory, input: {},
    configuration: {
      id: 'nim2598-live-configuration', workspaceId: 'nim2598-live-workspace', agentId: 'nim2598-live-agent', version: 1,
      prompt: { system: 'Follow explicit shell instructions by using the native shell tool; never simulate tool results.' },
      assignedSkills: [], harness: {
        harness: 'codex', model: process.env.CODEX_MODEL ?? 'gpt-6-luna', reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard',
        advanced: structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION),
      },
      contentHash: 'sha256:nim2598-live', createdAt: new Date().toISOString(),
    },
  }
}

// The approval scenario uses POSIX shell syntax. It is not Windows acceptance.
describe.skipIf(!enabled || process.platform === 'win32')('authenticated qualified Codex app-server acceptance', () => {
  it('selects and runs the installed Codex model at medium effort', async () => {
    const manager = new CodexAppServerSessionManager(binary)
    const directory = await mkdtemp(join(tmpdir(), 'codex-dynamic-model-'))
    const signal = AbortSignal.timeout(120_000)
    try {
      const options = await manager.discoverModels(directory, signal)
      assert.equal(options.providerVersion, process.env.CODEX_EXPECTED_LIVE_VERSION ?? 'codex-cli 0.160.0')
      const model = options.models.find(row => row.id === (process.env.CODEX_MODEL ?? 'gpt-6-luna'))
      assert(model)
      assert(model.reasoningEfforts.includes('medium'))
      const session = await manager.createSession({ request: request(directory) }, signal)
      for await (const event of manager.startTurn(session, {
        prompt: 'Reply with DYNAMIC_COMPATIBLE.', clientCorrelationId: 'dynamic-model-live',
      }, signal)) void event
      const result = await manager.reconcile(session, 'dynamic-model-live', signal)
      assert.equal(result.terminalResult?.outcome, 'succeeded')
      assert(outputText(result.terminalResult?.output).includes('DYNAMIC_COMPATIBLE'))
    } finally {
      await manager.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('measures installed schemas, approves, continues, cancels and reattaches the same native session', async () => {
    const directory = process.cwd()
    const scratch = await mkdtemp(join(tmpdir(), 'graphql-hap02-live-'))
    const marker = join(scratch, 'approved-command.txt')
    const manager = new CodexAppServerSessionManager(binary)
    const restored = new CodexAppServerSessionManager(binary)
    const input = { request: request(directory) }
    const signal = AbortSignal.timeout(230_000)
    try {
      const evidence = await manager.qualificationEvidence(signal)
      assert.match(evidence.schemaManifestSha256, /^[a-f0-9]{64}$/)
      assert.equal(evidence.schemaVerification, 'installed-contract-validation')
      assert.equal(evidence.productionSupported, false)
      const session = await manager.createSession(input, signal)
      const approval = (async () => {
        for await (const event of manager.startTurn(session, {
          prompt: `Run this exact shell command until it succeeds: set -e; stamp=$(date +%s%N); printf "$stamp" > ${JSON.stringify(marker)}; printf "$stamp". Request native command approval when the read-only sandbox blocks it. Do not simulate success. Return its stdout verbatim.`,
          clientCorrelationId: 'nim2598-live-approval',
        }, signal)) void event
      })()
      void approval.catch(() => undefined)
      let pending: PendingNativeInteraction | undefined
      for (let attempt = 0; attempt < 240; attempt += 1) {
        pending = await manager.pending(session)
        if (pending) break
        signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.equal(pending?.nativeRequestType, 'item/commandExecution/requestApproval')
      const option = pending!.responseOptions.find((entry) => entry.semantic === 'approve_once')
      assert(option)
      await manager.respond(session, pending!.turn.nativeRequestId!, option, signal)
      await approval
      const markerValue = await readFile(marker, 'utf8')
      assert.match(markerValue, /^\d{16,}$/)
      assert(outputText((await manager.history(session)).terminalResult?.output).includes(markerValue))
      for await (const event of manager.startTurn(session, { prompt: 'Reply exactly HAP02_CONTINUED. Do not use tools.', clientCorrelationId: 'continue' }, signal)) void event
      assert(outputText((await manager.history(session)).terminalResult?.output).includes('HAP02_CONTINUED'))
      assert((await manager.inspectConfiguration(session, false, signal)).config)
      assert(Array.isArray((await manager.inspectNativeMcp(session, signal)).data))

      // Cancel while startup may still be in progress; the manager must target the new ID.
      const interrupt = (async () => {
        for await (const event of manager.startTurn(session, {
          prompt: 'Run this exact shell command and wait for it to finish before answering: sleep 120. Do not simulate the command.',
          clientCorrelationId: 'interrupt',
        }, signal)) void event
      })()
      void interrupt.catch(() => undefined)
      try {
        assert.equal(await manager.cancel(session, signal), true)
      } catch (error) {
        if (error instanceof CodexRpcError) assert.fail(`Native turn/interrupt failed: ${error.nativeMessage ?? 'no provider diagnostic'}`)
        throw error
      }
      await interrupt
      assert.equal((await manager.history(session)).terminalResult?.outcome, 'canceled')
      await manager.close(session)
      assert.deepEqual(await restored.attachSession(session, input, signal), session)
      const recovered = await restored.reconcile(session, 'interrupt', signal)
      assert.equal(recovered.terminalResult?.outcome, 'canceled')
      for await (const event of restored.startTurn(session, { prompt: 'Reply exactly HAP02_REATTACHED. Do not use tools.', clientCorrelationId: 'reattached' }, signal)) void event
      assert(outputText((await restored.history(session)).terminalResult?.output).includes('HAP02_REATTACHED'))

      // Continued/reattached turns above cover the sole execution transport.
    } finally {
      try { await Promise.all([manager.shutdown(), restored.shutdown()]) }
      finally { await rm(scratch, { recursive: true, force: true }) }
    }
  }, 240_000)
})

describe.skipIf(process.env.RUN_CODEX_LOGIN_BOOTSTRAP_TESTS !== '1')('fresh unauthenticated Codex control transport', () => {
  it('starts and cancels device login from an empty home without an execution session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'graphql-codex-login-'))
    const previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    const manager = new CodexAppServerSessionManager(binary)
    try {
      const login = await manager.startDeviceCodeLogin(undefined, AbortSignal.timeout(60_000))
      assert.equal(typeof login.loginId, 'string')
      // Never print the short-lived login URL/code or write them to test artifacts.
      await manager.cancelLogin(undefined, String(login.loginId), AbortSignal.timeout(30_000))
    } finally {
      try { await manager.shutdown() } finally {
        if (previous === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = previous
        await rm(home, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
