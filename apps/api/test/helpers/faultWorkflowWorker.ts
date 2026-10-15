import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import type { AcceptedNodePlacement, DispatchIntent, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { DeviceConnectionError } from '../../src/modules/devices/deviceWire.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { RemoteExecutionHost } from '../../src/modules/runs/remote/executionHost.js'
import { RemoteNativeSessionManager } from '../../src/modules/runs/remote/nativeManagerProxy.js'
import { RemoteOperationJournal } from '../../src/modules/runs/remote/operationJournal.js'
import { ActivityProductionReplay } from './activityProductionReplay.js'

const digest = 'a'.repeat(64)

/** In-process Worker and journal, with a recorded native harness and a faultable device carrier. */
export async function faultWorkflowWorker(directory: string, options: { mcpUnavailable?: boolean | undefined } = {}) {
  const replay = new ActivityProductionReplay('fault-session')
  const infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected recorded harness infrastructure')
  let mcpReady = !options.mcpUnavailable
  let unavailableInspections = 0
  const timers = new Map<ReturnType<typeof setTimeout>, { delayMs: number; fire(): void }>()
  const dependencies = { ...infrastructure.codex,
    schedule: ((...args: Parameters<typeof setTimeout>) => {
      const [callback, delayMs, ...callbackArgs] = args
      const fire = () => { timers.delete(timer); callback(...callbackArgs) }
      const timer = setTimeout(fire, delayMs)
      timers.set(timer, { delayMs: delayMs ?? 0, fire })
      return timer
    }) as typeof setTimeout,
    cancelTimer: ((timer) => {
      timers.delete(timer as ReturnType<typeof setTimeout>)
      clearTimeout(timer)
    }) as typeof clearTimeout,
    transport: (...args: Parameters<typeof infrastructure.codex.transport>) => {
      const transport = infrastructure.codex.transport(...args)
      return { ...transport, request: async (...requestArgs: Parameters<typeof transport.request>) => {
        const [method] = requestArgs
        if (method === 'mcpServerStatus/list' && args[1] === '/worker/project' && !mcpReady) {
          unavailableInspections += 1
          return { data: [], nextCursor: null }
        }
        return transport.request(...requestArgs)
      } }
    },
  }
  const adapters: CodexAppServerSessionManager[] = []
  const manager = () => {
    const adapter = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'scoped', undefined, dependencies)
    adapters.push(adapter)
    return adapter
  }
  const connection: DeviceConnectionIdentity = {
    mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1,
  }
  const journalPath = join(directory, 'worker-journal')
  let journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  let incarnationId = randomUUID()
  const openHost = () => new RemoteExecutionHost({
    journal, connection, incarnationId,
    managers: new ExecutionScopedNativeSessionManagerResolver(manager),
    authorize: async () => undefined,
    preflight: async (request, access) => access ? {
      agentId: request.configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: access.token },
    } : undefined,
    attestRuntimeLeaf: async (intent, _placement, request, executionPlacement) => ({
      executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId,
      bindingHash: executionPlacement?.bindingHash ?? intent.bindingHash,
      canonicalRuntimeDirectory: request.runtimeDirectory, directoryIdentityHash: digest,
      materializationId: executionPlacement?.workingTree.materializationId ?? 'fixture-materialization',
      materializationDigest: executionPlacement?.workingTree.materializationDigest ?? digest,
    }),
    nativeEvidence: async (_intent, session) => ({ sessionId: session.nativeSessionId, processIdentityDigest: digest }),
    settle: async (_intent, history) => history.terminalTurn ? {
      kind: history.terminalTurn.result.outcome === 'canceled' ? 'cancelled' : 'completed',
      result: history.terminalTurn.result, closureEvidenceDigest: digest,
    } : null,
  })
  let host = openHost()
  const operations = new Set<string>()
  let connected = true
  let rejectedRequests = 0
  const methods: string[] = []
  return {
    replay, connection, manager,
    get unavailableInspections() { return unavailableInspections },
    makeMcpReady() { mcpReady = true },
    advanceNativeTimer(delayMs: number) {
      const entry = [...timers].find(([, timer]) => timer.delayMs === delayMs)
      if (!entry) return false
      clearTimeout(entry[0])
      entry[1].fire()
      return true
    },
    get journal() { return journal },
    get incarnationId() { return incarnationId },
    get rejectedRequests() { return rejectedRequests },
    methods,
    disconnect() { connected = false },
    reconnect() { connected = true },
    async restart() {
      connected = false
      await host.shutdown()
      for (const operationId of operations) {
        const status = await journal.status(operationId)
        if (status.status === 'known' && status.receipt.native && !status.receipt.terminal) {
          await journal.terminal(operationId, { kind: 'failed', closureEvidenceDigest: digest,
            result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED',
              message: 'The Worker restarted before the turn completed.', retryable: true } } })
        }
      }
      await journal.close()
      journal = await RemoteOperationJournal.open(journalPath)
      incarnationId = randomUUID()
      connection.bootId = randomUUID()
      connection.connectionGeneration += 1
      host = openHost()
      connected = true
    },
    proxy(placement: AcceptedNodePlacement, intent: DispatchIntent,
      configuration: ConstructorParameters<typeof RemoteNativeSessionManager>[0]['configuration'],
      executionPlacement: NativeExecutionPlacement,
      observeReceipt: (receipt: RemoteOperationReceipt) => Promise<void>) {
      operations.add(intent.operationId)
      return new RemoteNativeSessionManager({
        intent, placement, configuration, harness: 'codex', observeReceipt,
        transport: { request: async (method, raw) => {
          methods.push(method)
          if (!connected) {
            rejectedRequests += 1
            throw new DeviceConnectionError('transport')
          }
          const payload = ['prepare', 'reattach', 'capabilities', 'inspect-mcp'].includes(method)
            ? { ...(raw as object), executionPlacement } : raw
          return host.handle(RemoteExecutionRpcRequestSchema.parse(payload))
        } },
        controlFor: async ({ native }) => ({
          schemaVersion: 1, protocolVersion: 1, commandId: randomUUID(), operationId: intent.operationId,
          executionId: intent.executionId, attemptId: intent.attemptId, bindingHash: intent.bindingHash,
          owner: intent.owner, native, action: { kind: 'stop' },
        }),
      })
    },
    async close() {
      connected = true
      await host.shutdown()
      for (const adapter of adapters) await adapter.dispose()
      await journal.close()
    },
  }
}
