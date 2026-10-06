import { awaitNativeOutputContext } from './nativeOutputAdmission.js'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import { WorkerMcpRelayRequestSchema, WorkerMcpRelayResponseSchema, WorkerNativeOutputAuthorizationSchema,
  WorkerNativeOutputDeclarationsAuthorizationSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { DeviceConnectionSupervisor } from '../../devices/connectionSupervisor.js'
import { createChannelTransferClient } from '../../byte-transfer/carrier.js'
import { identity, openPrivateRoot, openChildDirectory } from '../../sources/privateFilesystem.js'
import type { CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import { assertCodexProtectedOutputPlacement } from '../../harnesses/qualification/suites/codexNativeOutputSandbox.js'
import { createNativeOutputBudgetLedger } from './installedNativeOutputStorage.js'
import type { InstalledNativeOutputProviders } from './installedNativeOutput.js'
import type { WorkflowNativeOutputs } from '../../harnesses/workflowNativeOutput.js'
import { createBufferedNativeOutputs, NativeOutputMemoryBudget } from './bufferedNativeOutput.js'
import { WorkerNativeArtifactSender } from './workerNativeArtifactSender.js'
import type { InstalledWorkflowHostOptions, InstalledWorkflowNativeOutputContext } from './installedWorkflowHost.js'
import { observedWorkflowArtifactPublication } from './workerMcpEndpoint.js'
import { DomainError } from '../../errors.js'
import { nativeOutputBudgetLimits, workerOutputInstallation,
  openInstalledWorkflowOutputDirectories } from './installedWorkflowOutputStore.js'
export { ensureInstalledWorkflowOutputStore } from './installedWorkflowOutputStore.js'

const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original installed output store, native owner and Main authorization are required.', 409)

function qualificationIdentity(input: CodexNativeOutputQualificationInput) {
  const { configuration, binary, binaryIdentity, providerVersion, schemaIdentity, expectedSandbox } = input
  return { configuration, binary, binaryIdentity, providerVersion, schemaIdentity, expectedSandbox }
}

const ToolReply = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]),
  result: z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional() }).passthrough() })

function structuredToolReply(id: string, response: ReturnType<typeof WorkerMcpRelayResponseSchema.parse>): unknown {
  if (response.statusCode !== 200 || response.contentType === 'empty') throw unavailable()
  const messages = response.contentType === 'application/json' ? [response.body]
    : response.body.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
  const replies = messages.map(message => ToolReply.safeParse(JSON.parse(message)))
    .flatMap(parsed => parsed.success && parsed.data.id === id ? [parsed.data] : [])
  if (replies.length !== 1 || !replies[0]?.result || replies[0].result.isError
    || replies[0].result.structuredContent === undefined) throw unavailable()
  return replies[0].result.structuredContent
}

export function createInstalledWorkflowNativeOutputFactory(input: {
  stateDirectory: string
  pairing: WorkerPairingConfiguration
  connection(): Pick<DeviceConnectionSupervisor, 'captureRequest'> | undefined
}): NonNullable<InstalledWorkflowHostOptions['nativeOutputs']> {
  let budget: Promise<Awaited<ReturnType<typeof createNativeOutputBudgetLedger>>> | undefined
  return (context: InstalledWorkflowNativeOutputContext): InstalledNativeOutputProviders => {
    const payload = context.placement.payload
    if (payload.kind !== 'agent' || !payload.artifactOutputs) throw unavailable()
    const transfer = createChannelTransferClient({ captureRequest: namespace => input.connection()?.captureRequest(namespace) })
    let qualified: ReturnType<typeof qualificationIdentity> | undefined
    let directory: string | undefined
    let filesystem: Awaited<ReturnType<typeof identity>> | undefined
    let ledger: Awaited<ReturnType<typeof createNativeOutputBudgetLedger>> | undefined
    const current = async (signal?: AbortSignal) => {
      await context.assertCurrent(undefined, signal)
      if (directory && filesystem) {
        const root = await openPrivateRoot(directory)
        try { if (!isDeepStrictEqual(await identity(root), filesystem)) throw unavailable() }
        finally { await root.close() }
      }
      signal?.throwIfAborted()
    }
    const request = async (operation: 'worker-mcp.authorize-native-output-declarations' | 'worker-mcp.authorize-native-output'
      | 'worker-mcp.request', details: Record<string, unknown>, signal?: AbortSignal) => {
      await current(signal)
      const envelope = WorkerMcpRelayRequestSchema.parse({ version: 1, operation, intent: context.currentIntent(),
        placement: context.placement, applicationAccess: context.applicationAccess(), ...details })
      const response = await context.requestMain(envelope, signal)
      await current(signal)
      if (response.bytes !== undefined) throw unavailable()
      return response.payload
    }
    const authorizeLease = (lease: { mainId: string; executionId: string; operationId: string; attemptId: string;
      bindingHash: string; agentId: string; expiresAt: string }) => {
      if (lease.mainId !== context.intent.mainId || lease.executionId !== context.intent.executionId
        || lease.operationId !== context.intent.operationId || lease.attemptId !== context.intent.attemptId
        || lease.bindingHash !== context.intent.bindingHash || lease.agentId !== payload.agentId
        || Date.parse(lease.expiresAt) <= Date.now()) throw unavailable()
    }
    const call = async (name: string, args: Record<string, unknown>, commandId: string, signal?: AbortSignal) => {
      const body = { jsonrpc: '2.0' as const, id: commandId, method: 'tools/call' as const,
        params: { name, arguments: args } }
      const response = WorkerMcpRelayResponseSchema.parse(await request('worker-mcp.request', { body }, signal))
      return { body, response, result: structuredToolReply(commandId, response) }
    }
    return {
      assertCurrent: current,
      assertQualified: async (qualification, signal) => {
        await current(signal)
        const declarations = WorkerNativeOutputDeclarationsAuthorizationSchema.parse(
          await request('worker-mcp.authorize-native-output-declarations', {}, signal))
        authorizeLease(declarations)
        if (declarations.agentConfigurationVersionId !== payload.agentConfigurationVersionId) throw unavailable()
        const store = await openInstalledWorkflowOutputDirectories(input.stateDirectory)
        assertCodexProtectedOutputPlacement(store.rootDirectory, qualification.expectedSandbox)
        budget ??= createNativeOutputBudgetLedger({ rootDirectory: join(store.rootDirectory, 'budget'),
          installation: workerOutputInstallation(input.pairing), limits: nativeOutputBudgetLimits })
        ledger = await budget
        directory = store.rootDirectory
        filesystem = store.filesystem
        const captured = qualificationIdentity(qualification)
        if (qualified && !isDeepStrictEqual(qualified, captured)) throw unavailable()
        if (!qualified) {
          await context.qualifyNativeOutput(qualification, store.rootDirectory, signal)
          await current(signal)
          qualified = structuredClone(captured)
        }
      },
      authorize: async (pin, operation, signal) => {
        const authorization = WorkerNativeOutputAuthorizationSchema.parse(await awaitNativeOutputContext(async bounded => {
          await context.assertCurrent(pin, bounded)
          return request('worker-mcp.authorize-native-output',
            { outputOperation: operation, nativeSessionId: pin.session.nativeSessionId, turnId: pin.nativeTurnId }, bounded)
        }, signal))
        authorizeLease(authorization)
        if (authorization.outputOperation !== operation || authorization.nativeSessionId !== pin.session.nativeSessionId
          || authorization.turnId !== pin.nativeTurnId) throw unavailable()
        return authorization.scope
      },
      storage: (prepared, pin) => {
        if (!qualified || !directory || !ledger || !isDeepStrictEqual(qualified, qualificationIdentity(prepared))) throw unavailable()
        const rootDirectory = join(directory, 'turns', commandInputHash([context.intent, pin.session, pin.nativeTurnId])
          .slice('sha256:'.length))
        return { rootDirectory, owner: { intent: context.intent, binding: context.binding, session: pin.session,
          nativeTurnId: pin.nativeTurnId, runtimeGeneration: pin.runtimeGeneration },
          limits: nativeOutputBudgetLimits, budget: ledger,
          assertCurrent: signal => context.assertCurrent(pin, signal), protection: {
            assertProtected: async (owner, signal) => {
              if (!isDeepStrictEqual(owner.intent, context.intent) || !isDeepStrictEqual(owner.session, pin.session)
                || owner.nativeTurnId !== pin.nativeTurnId || owner.runtimeGeneration !== pin.runtimeGeneration) throw unavailable()
              await context.assertCurrent(pin, signal)
              await current(signal)
              const parent = await openPrivateRoot(join(directory!, 'turns'))
              try {
                const child = await openChildDirectory(parent, rootDirectory.slice(rootDirectory.lastIndexOf('/') + 1), true)
                await child.close()
              } finally { await parent.close() }
              assertCodexProtectedOutputPlacement(rootDirectory, prepared.effectiveSandbox)
              await context.assertCurrent(pin, signal)
            },
            assertQuiescent: owner => context.closeNativeOutputWriters(owner),
          } }
      },
      artifacts: {
        binding: { intent: context.intent, placement: context.placement,
          root: { rootId: context.materialization.receipt.binding.rootId,
            rootBindingRevision: context.materialization.receipt.binding.bindingRevision } },
        receiver: transfer.receiver, connection: transfer.connection,
        main: {
          admit: async (declaration, signal) => TransferIntentSchema.parse((await call('files.admit_transferred_result',
            declaration, declaration.commandId, signal)).result),
          publish: async (publication, signal) => {
            const called = await call('files.publish_transferred_result', publication, publication.publication.commandId, signal)
            const observed = observedWorkflowArtifactPublication(called.body, called.response)
            if (!observed) throw unavailable()
            context.observeArtifactPublication(observed.input, observed.result)
            return observed.result
          },
        },
      },
    }
  }
}

export function createInstalledWorkflowBufferedNativeOutputFactory(input: {
  connection(): Pick<DeviceConnectionSupervisor, 'captureRequest'> | undefined
}): (context: InstalledWorkflowNativeOutputContext) => WorkflowNativeOutputs {
  const budget = new NativeOutputMemoryBudget()
  return context => {
    const payload = context.placement.payload
    if (payload.kind !== 'agent' || !['codex', 'opencode'].includes(payload.driverId) || !payload.artifactOutputs) throw unavailable()
    const transfer = createChannelTransferClient({ captureRequest: namespace => input.connection()?.captureRequest(namespace) })
    const request = async (operation: 'worker-mcp.authorize-native-output-declarations'
      | 'worker-mcp.authorize-native-output' | 'worker-mcp.request', details: Record<string, unknown>, signal?: AbortSignal) => {
      await context.assertCurrent(undefined, signal)
      const envelope = WorkerMcpRelayRequestSchema.parse({ version: 1, operation,
        intent: context.currentIntent(), placement: context.placement, applicationAccess: context.applicationAccess(), ...details })
      const response = await context.requestMain(envelope, signal)
      await context.assertCurrent(undefined, signal)
      if (response.bytes !== undefined) throw unavailable()
      return response.payload
    }
    const checkLease = (lease: { mainId: string; executionId: string; operationId: string;
      attemptId: string; bindingHash: string; agentId: string; expiresAt: string }) => {
      if (lease.mainId !== context.intent.mainId || lease.executionId !== context.intent.executionId
        || lease.operationId !== context.intent.operationId || lease.attemptId !== context.intent.attemptId
        || lease.bindingHash !== context.intent.bindingHash || lease.agentId !== payload.agentId
        || Date.parse(lease.expiresAt) <= Date.now()) throw unavailable()
    }
    const call = async (name: string, args: unknown, commandId: string, signal?: AbortSignal) => {
      const body = { jsonrpc: '2.0' as const, id: commandId, method: 'tools/call' as const,
        params: { name, arguments: args } }
      const response = WorkerMcpRelayResponseSchema.parse(await request('worker-mcp.request', { body }, signal))
      return { body, response, result: structuredToolReply(commandId, response) }
    }
    return createBufferedNativeOutputs({ budget,
      assertCurrent: signal => context.assertCurrent(undefined, signal),
      assertQualified: async (qualification, signal) => {
        if ('directory' in qualification) {
          if (qualification.configuration.nativeAgent === 'plan') throw unavailable()
          await context.qualifyOpenCodeNativeOutput(qualification, signal)
        } else {
          if (qualification.configuration.sandbox === 'read-only') throw unavailable()
          await context.qualifyBufferedCodexNativeOutput(qualification, signal)
        }
        const authorization = WorkerNativeOutputDeclarationsAuthorizationSchema.parse(
          await request('worker-mcp.authorize-native-output-declarations', {}, signal))
        checkLease(authorization)
        if (authorization.agentConfigurationVersionId !== payload.agentConfigurationVersionId) throw unavailable()
      },
      authorize: async (pin, operation, signal) => {
        await context.assertCurrent(pin, signal)
        const authorization = WorkerNativeOutputAuthorizationSchema.parse(await awaitNativeOutputContext(async bounded => {
          await context.assertCurrent(pin, bounded)
          return request('worker-mcp.authorize-native-output', {
            outputOperation: operation, nativeSessionId: pin.session.nativeSessionId, turnId: pin.nativeTurnId,
          }, bounded)
        }, signal))
        checkLease(authorization)
        if (authorization.outputOperation !== operation || authorization.nativeSessionId !== pin.session.nativeSessionId
          || authorization.turnId !== pin.nativeTurnId) throw unavailable()
        await context.assertCurrent(pin, signal)
        return authorization.scope
      },
      publish: async (publication, source, callback, signal) => {
        const sender = new WorkerNativeArtifactSender({ intent: context.intent, placement: context.placement,
          root: { rootId: context.materialization.receipt.binding.rootId,
            rootBindingRevision: context.materialization.receipt.binding.bindingRevision } }, source, {
          admit: async (declaration, bounded) => TransferIntentSchema.parse(
            (await call('files.admit_transferred_result', declaration, declaration.commandId, bounded)).result),
          publish: async (value, bounded) => {
            const called = await call('files.publish_transferred_result', value, value.publication.commandId, bounded)
            const observed = observedWorkflowArtifactPublication(called.body, called.response)
            if (!observed) throw unavailable()
            context.observeArtifactPublication(observed.input, observed.result)
            return observed.result
          },
        }, transfer.receiver, transfer.connection)
        return sender.publish(publication, callback, signal)
      },
    })
  }
}
