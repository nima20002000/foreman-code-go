import { createHash, randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { withAdvancedDefaults } from '@graphql/contracts'
import type { CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import { CodexStdioTransport, object } from '../../harnesses/codexStdioTransport.js'
import { createInstalledCodexDependencies } from '../../harnesses/installedCodexDependencies.js'
import type { createInstalledCodexQualificationReader } from '../../harnesses/installedCodexQualification.js'
import { inheritedAgentEnvironment } from '../../harnesses/secrets.js'
import type { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { harnessProfile } from '../../harnesses/qualification/profiles.js'
import { assertCodexProtectedOutputPlacement, runCodexNativeOutputSandboxChecks,
  type CodexNativeSandboxProbeObservation } from '../../harnesses/qualification/suites/codexNativeOutputSandbox.js'
import { DomainError } from '../../errors.js'

const unavailable = () => new DomainError('CODEX_NATIVE_OUTPUT_UNQUALIFIED',
  'The installed native command and its subprocess must be denied writes to the output store.', 409)

/** A separate diagnostic owner has no workflow credential or file tools. */
export async function qualifyInstalledNativeOutputSandbox(input: {
  qualification: CodexNativeOutputQualificationInput
  protectedDirectory: string
  reader: ReturnType<typeof createInstalledCodexQualificationReader>
  codexSuiteRevision: string
  registry: NativeProcessRegistry
  assertCurrent(signal?: AbortSignal): Promise<void>
  signal: AbortSignal
}): Promise<void> {
  const q = input.qualification
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)])
  const dependencies = createInstalledCodexDependencies(input)
  const environment = inheritedAgentEnvironment()
  const scope = input.registry.scope(`qualification:native-output:${randomUUID()}`)
  let transport: CodexStdioTransport | undefined
  let threadId = ''
  let turnId = ''
  let command = ''
  const observations: CodexNativeSandboxProbeObservation[] = []
  const started = new Set<string>()
  let wake = () => {}
  let failure: Error | undefined
  let result: Awaited<ReturnType<typeof runCodexNativeOutputSandboxChecks>> | undefined
  const current = async () => {
    signal.throwIfAborted()
    await input.assertCurrent(signal)
    signal.throwIfAborted()
  }
  const cleanup = async () => {
    const errors: unknown[] = []
    try { await transport?.close() }
    catch (error) { errors.push(error) }
    let ownerClosed = false
    try {
      ownerClosed = await input.registry.closeOwner(scope.owner)
      if (!ownerClosed) errors.push(unavailable())
    } catch (error) { errors.push(error) }
    const paths = result?.evidence.cleanupPaths
    if (ownerClosed && Array.isArray(paths)) {
      for (const path of paths) {
        if (typeof path !== 'string') {
          errors.push(unavailable())
          continue
        }
        try { await unlink(path) }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
            errors.push(error)
          }
        }
      }
    }
    return errors
  }
  try {
    await current()
    const qualified = await dependencies.qualify(q.binary, q.providerVersion, q.expectedSandbox.cwd,
      environment, true, signal, scope)
    if (qualified.identity !== q.binaryIdentity || qualified.schemaManifestSha256 !== q.schemaIdentity
      || qualified.providerVersion !== q.providerVersion) throw unavailable()
    const listed = await dependencies.runCommand(q.binary, ['mcp', 'list', '--json'], q.expectedSandbox.cwd,
      signal, environment, { recovery: scope })
    const entries: unknown = JSON.parse(listed.stdout)
    if (listed.exitCode !== 0 || !Array.isArray(entries) || entries.length > 500
      || entries.some(entry => typeof object(entry).name !== 'string')) throw unavailable()
    const disabled = entries.map(entry => String(object(entry).name))
    transport = new CodexStdioTransport(q.binary, q.expectedSandbox.cwd, environment, qualified.protocol,
      async request => { await transport!.reject(request.id, -32601, 'Diagnostic interaction unavailable.') },
      (method, params) => {
        if (params.threadId !== threadId) return
        const item = params.item && typeof params.item === 'object' ? object(params.item) : undefined
        if (item?.type === 'commandExecution' && typeof params.turnId === 'string' && typeof item.id === 'string') {
          const key = `${params.turnId}:${item.id}`
          if (method === 'item/started' && item.command === command) {
            if (started.size >= 128) { failure = unavailable(); wake(); return }
            started.add(key)
          }
          if (method === 'item/completed' && item.command === command && started.has(key)) {
            if (observations.length >= 128 || typeof item.aggregatedOutput !== 'string'
              || Buffer.byteLength(item.aggregatedOutput) > 64 * 1024) { failure = unavailable(); wake(); return }
            observations.push({ nativeSessionId: threadId, nativeTurnId: params.turnId, itemId: item.id,
              command: String(item.command), status: String(item.status),
              exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
              aggregatedOutput: item.aggregatedOutput })
            wake()
          }
        }
      }, error => { failure = error; wake() }, 30_000, scope, disabled)
    await transport.start(signal)
    const draft = withAdvancedDefaults(q.configuration).advanced!
    const response = object(await transport.request('thread/start', {
      cwd: q.expectedSandbox.cwd, runtimeWorkspaceRoots: [q.expectedSandbox.cwd, ...q.expectedSandbox.writableRoots],
      sandbox: q.configuration.sandbox, model: q.configuration.model,
      approvalPolicy: draft.approvalPolicy, approvalsReviewer: draft.approvalsReviewer, ephemeral: true,
      config: { ...Object.fromEntries(disabled.map(name => [`mcp_servers.${name}.enabled`, false])),
        sandbox_workspace_write: { writable_roots: [...q.expectedSandbox.writableRoots],
          network_access: q.expectedSandbox.networkAccess,
          exclude_tmpdir_env_var: q.expectedSandbox.excludeTmpdirEnvVar,
          exclude_slash_tmp: q.expectedSandbox.excludeSlashTmp } },
    }, signal))
    threadId = String(object(response.thread).id ?? '')
    const sandbox = object(response.sandbox)
    const writableRoots = sandbox.writableRoots
    if (!threadId || response.cwd !== q.expectedSandbox.cwd || sandbox.type !== 'workspaceWrite'
      || !Array.isArray(writableRoots) || writableRoots.some(root => typeof root !== 'string')
      || sandbox.networkAccess !== q.expectedSandbox.networkAccess
      || sandbox.excludeTmpdirEnvVar !== q.expectedSandbox.excludeTmpdirEnvVar
      || sandbox.excludeSlashTmp !== q.expectedSandbox.excludeSlashTmp) throw unavailable()
    const allowed = new Set([q.expectedSandbox.cwd, ...q.expectedSandbox.writableRoots])
    if (writableRoots.some(root => !allowed.has(root))
      || q.expectedSandbox.writableRoots.some(root => !writableRoots.includes(root))) throw unavailable()
    assertCodexProtectedOutputPlacement(input.protectedDirectory,
      { ...q.expectedSandbox, writableRoots: writableRoots as string[] })
    const profile = harnessProfile('codex', q.providerVersion)
    if (!profile) throw unavailable()
    const binarySha256 = createHash('sha256').update(await readFile(q.binary)).digest('hex')
    result = await runCodexNativeOutputSandboxChecks({ binary: q.binary, binarySha256,
      version: q.providerVersion, profile, model: q.configuration.model,
      workDirectory: q.expectedSandbox.cwd, protectedDirectory: input.protectedDirectory,
      schemaIdentity: q.schemaIdentity, signal, assertInstallation: current,
      probe: {
        assertCurrent: async () => { await current(); await dependencies.assertUnchanged(qualified) },
        capturePolicy: async (_signal, requested) => {
          command = requested
          const response = object(await transport!.request('turn/start', { threadId,
            clientUserMessageId: randomUUID(), input: [{ type: 'text',
              text: `Run exactly this command once, without changes or other tools, then finish: ${requested}`,
              text_elements: [] }] }, signal))
          turnId = String(object(response.turn).id ?? '')
          if (!turnId) throw unavailable()
          return { binarySha256, providerVersion: q.providerVersion, schemaIdentity: q.schemaIdentity,
            nativeSessionId: threadId, nativeTurnId: turnId, sandboxType: String(sandbox.type),
            effectiveSandbox: { ...q.expectedSandbox, writableRoots: writableRoots as string[] } }
        },
        executeExactCommand: async requested => {
          if (!turnId || requested !== command) throw unavailable()
          for (;;) {
            await current()
            if (failure) throw failure
            const observation = observations.find(item => item.nativeTurnId === turnId && item.command === requested)
            if (observation) return observation
            await new Promise<void>((resolve, reject) => {
              const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
              wake = () => { signal.removeEventListener('abort', abort); resolve() }
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
              else if (failure || observations.some(item => item.nativeTurnId === turnId)) wake()
            })
          }
        },
      } })
    if (result.checks.some(check => !check.passed)) throw unavailable()
    await current()
  } catch (error) {
    const cleanupErrors = await cleanup()
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], 'Native output qualification and cleanup failed.')
    }
    throw error
  }
  const cleanupErrors = await cleanup()
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, 'Native output qualification cleanup failed.')
  }
}
