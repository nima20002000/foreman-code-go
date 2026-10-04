import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { z } from 'zod'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema } from '@graphql/contracts/byte-transfer'
import { WorkerMcpRelayRequestSchema, WorkerMcpRelayResponseSchema, WorkerNativeOutputAuthorizationSchema,
  WorkerNativeOutputDeclarationsAuthorizationSchema } from '@graphql/contracts/worker-mcp-relay'
import type { WorkerPairingConfiguration } from '@graphql/contracts/device-identity'
import type { DeviceConnectionSupervisor } from '../../devices/connectionSupervisor.js'
import { createChannelTransferClient } from '../../byte-transfer/carrier.js'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../../sources/privateFilesystem.js'
import type { CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import { assertCodexProtectedOutputPlacement } from '../../harnesses/qualification/suites/codexNativeOutputSandbox.js'
import { createNativeOutputBudgetLedger } from './installedNativeOutputStorage.js'
import type { InstalledNativeOutputProviders } from './installedNativeOutput.js'
import type { InstalledWorkflowHostOptions, InstalledWorkflowNativeOutputContext } from './installedWorkflowHost.js'
import { observedWorkflowArtifactPublication } from './workerMcpEndpoint.js'
import { DomainError } from '../../errors.js'

const limits = { maxDiskBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
  maxSnapshotBytes: BYTE_TRANSFER_POLICY.maxStagingBytes,
  maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal }
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original installed output store, native owner and Main authorization are required.', 409)

function installation(pairing: WorkerPairingConfiguration) {
  const { mainId, deviceId, workerInstallationId } = pairing
  return { mainId, deviceId, workerInstallationId }
}

async function outputDirectories(stateDirectory: string, options: { initialize?: true } = {}) {
  const state = await openPrivateRoot(stateDirectory)
  try {
    if (options.initialize) await mkdir(anchored(state, 'workflow-native-outputs'), { mode: 0o700 })
    const root = await openChildDirectory(state, 'workflow-native-outputs')
    try {
      const budget = await openChildDirectory(root, 'budget', options.initialize === true)
      await budget.close()
      const turns = await openChildDirectory(root, 'turns', options.initialize === true)
      await turns.close()
      if (options.initialize) { await root.sync(); await state.sync() }
      return { rootDirectory: join(stateDirectory, 'workflow-native-outputs'), filesystem: await identity(root) }
    } finally { await root.close() }
  } finally { await state.close() }
}

/** Explicit installer action; startup cannot replace a missing budget journal. */
export async function initializeInstalledWorkflowOutputStore(stateDirectory: string, pairing: WorkerPairingConfiguration) {
  const state = await openPrivateRoot(stateDirectory)
  try {
    const existing = await lstat(anchored(state, 'workflow-native-outputs')).catch(error => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing) throw new DomainError('WORKER_NATIVE_OUTPUT_STORE_EXISTS',
      'The installed native output store already exists.', 409)
    // The marker survives a lost store. An interrupted or established installation cannot be initialized again.
    const marker = await open(anchored(state, 'workflow-native-outputs-initialized.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await marker.writeFile(JSON.stringify(installation(pairing))); await marker.sync() }
    finally { await marker.close() }
    await state.sync()
  } finally { await state.close() }
  const store = await outputDirectories(stateDirectory, { initialize: true })
  await createNativeOutputBudgetLedger({ rootDirectory: join(store.rootDirectory, 'budget'),
    installation: installation(pairing), limits, initializeNewStore: true })
}

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
      const envelope = WorkerMcpRelayRequestSchema.parse({ version: 1, operation, intent: context.intent,
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
        const store = await outputDirectories(input.stateDirectory)
        assertCodexProtectedOutputPlacement(store.rootDirectory, qualification.expectedSandbox)
        budget ??= createNativeOutputBudgetLedger({ rootDirectory: join(store.rootDirectory, 'budget'),
          installation: installation(input.pairing), limits })
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
        const authorization = WorkerNativeOutputAuthorizationSchema.parse(await request('worker-mcp.authorize-native-output',
          { outputOperation: operation, nativeSessionId: pin.session.nativeSessionId, turnId: pin.nativeTurnId }, signal))
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
          nativeTurnId: pin.nativeTurnId, runtimeGeneration: pin.runtimeGeneration }, limits, budget: ledger,
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
