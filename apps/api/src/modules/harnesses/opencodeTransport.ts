import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnNativeProcess, type NativeProcessRecovery } from './recovery/processRegistry.js'
import { randomBytes } from 'node:crypto'

import type { OpenCodeAdvancedConfiguration } from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'
import type { NativeMcpEntryEvidence } from './mcpDetection.js'
import { inspectOpenCodeMcpConfiguration } from './opencodeMcpConfiguration.js'
import type { ChildProcessEnvironment } from './port.js'
import { PROCESS_SHUTDOWN_GRACE_MS, runCommand, signalTree } from './process.js'
import { inheritedAgentEnvironment, redactKnownSecrets, redactSecretText } from './secrets.js'
import { credentialReferences, digest, object, parseConfigObject } from './opencodeProtocol.js'
import { APP_MCP_TOKEN } from './appMcpLauncher.js'

export const QUALIFIED_OPENCODE_VERSION = '1.18.31'
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000
const APP_CREDENTIAL_ENV = APP_MCP_TOKEN

export type NativeDeliveryCertainty = 'definite' | 'uncertain'
export class OpenCodeNativeDeliveryError extends Error {
  constructor(readonly code: string, message: string, readonly certainty: NativeDeliveryCertainty, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OpenCodeNativeDeliveryError'
  }
}

export interface OpenCodeServerController {
  readonly expectedVersion: string
  readonly ownerAgentId?: string
  readonly advancedConfiguration?: OpenCodeAdvancedConfiguration | undefined
  readonly credentialEnvironmentFingerprint?: string | undefined
  /** Changes when the resident process is replaced, including automatic recovery. */
  readonly generation?: number
  /** Provenance from unexpanded configuration, never from resolved secret values. */
  readonly mcpCredentialReferences?: Readonly<Record<string, string>>
  inspectMcpConfiguration?(directory: string, serverName: string, signal?: AbortSignal): Promise<NativeMcpEntryEvidence | undefined>
  redact?<T>(value: T): T
  ensure(signal?: AbortSignal): Promise<void>
  request(path: string, init?: RequestInit, signal?: AbortSignal, expectedGeneration?: number): Promise<Response>
  dispose(): Promise<void>
  restart?(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void>
}

export interface ManagedOpenCodeServerOptions {
  processRecovery?: NativeProcessRecovery
  binary: string
  workingDirectory: string
  ownerAgentId: string
  credentialEnvironmentVariable?: string
  environment?: ChildProcessEnvironment
  pure?: boolean
  advancedConfiguration?: OpenCodeAdvancedConfiguration
  /** One budget for version probing, spawning, readiness and health, not per stage. */
  startupTimeoutMs?: number
}

export function childEnvironmentFingerprint(environment: ChildProcessEnvironment): string {
  return digest([environment.agentId, Object.entries(environment.variables).sort(([a], [b]) => a.localeCompare(b))])
}

/** Awaiting an owned process is cancelable without canceling another caller's process. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** One process and one serialized lifecycle for one logical Agent credential owner. */
export class ManagedOpenCodeServer implements OpenCodeServerController {
  readonly expectedVersion = QUALIFIED_OPENCODE_VERSION
  readonly advancedConfiguration: OpenCodeAdvancedConfiguration | undefined
  generation = 0
  private desiredEnvironment: ChildProcessEnvironment | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private baseUrl: string | undefined
  private password: string | undefined
  private lifecycle: Promise<unknown> = Promise.resolve()
  private startupAbort: AbortController | undefined
  private epoch = 0
  private cleanupRequired = false
  private disposal: Promise<void> | undefined
  private stderr = ''
  private readonly stops = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()
  private references: Readonly<Record<string, string>> = {}

  constructor(private readonly options: ManagedOpenCodeServerOptions) {
    this.advancedConfiguration = options.advancedConfiguration
    this.desiredEnvironment = this.validateEnvironment(options.environment)
    if (options.pure !== undefined && options.advancedConfiguration
      && options.pure !== (options.advancedConfiguration.plugins.mode === 'pure')) {
      throw new HarnessExecutionError('OPENCODE_PLUGIN_MODE_CONFLICT', 'Managed server pure mode conflicts with Advanced configuration.')
    }
    if (options.startupTimeoutMs !== undefined && (!Number.isFinite(options.startupTimeoutMs) || options.startupTimeoutMs <= 0)) {
      throw new Error('OpenCode startup timeout must be positive.')
    }
  }

  get ownerAgentId(): string { return this.options.ownerAgentId }

  get credentialEnvironmentFingerprint(): string | undefined {
    return this.desiredEnvironment ? childEnvironmentFingerprint(this.desiredEnvironment) : undefined
  }
  get mcpCredentialReferences(): Readonly<Record<string, string>> { return this.references }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(work)
    this.lifecycle = task.catch(() => undefined)
    return task
  }

  private validateEnvironment(environment?: ChildProcessEnvironment): ChildProcessEnvironment | undefined {
    if (environment && environment.agentId !== this.options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The credential does not belong to this OpenCode server owner.')
    }
    const credentialEnvironmentVariable = this.options.credentialEnvironmentVariable ?? APP_CREDENTIAL_ENV
    if (Object.keys(environment?.variables ?? {}).some((key) => key !== credentialEnvironmentVariable)
      || (environment && credentialEnvironmentVariable in environment.variables && !environment.variables[credentialEnvironmentVariable])) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_ENV_UNSUPPORTED', 'Only the scoped App credential environment variable is accepted.')
    }
    return environment ? { agentId: environment.agentId, variables: { ...environment.variables } } : undefined
  }

  redact<T>(value: T): T {
    return this.redactWithAdditionalSecrets(value, [])
  }

  redactWithAdditionalSecrets<T>(value: T, additionalSecrets: readonly string[]): T {
    const secrets = [...additionalSecrets, ...Object.values(this.desiredEnvironment?.variables ?? {})]
    if (this.password) secrets.push(this.password, Buffer.from(`opencode:${this.password}`).toString('base64'))
    return redactKnownSecrets(value, secrets)
  }

  async inspectMcpConfiguration(directory: string, serverName: string, signal?: AbortSignal): Promise<NativeMcpEntryEvidence | undefined> {
    const evidence = await inspectOpenCodeMcpConfiguration({
      binary: this.options.binary, workingDirectory: directory, serverName,
      credentialEnvironmentVariable: this.options.credentialEnvironmentVariable ?? APP_CREDENTIAL_ENV,
      pure: this.advancedConfiguration?.plugins.mode === 'pure' || this.options.pure === true,
      ...(signal ? { signal } : {}),
    })
    return evidence && this.advancedConfiguration?.mcp.serverEnabled[serverName] === false
      ? { ...evidence, enabled: false, status: 'disabled' } : evidence
  }

  async ensure(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const epoch = this.epoch
    return waitFor(this.exclusive(async () => {
      signal?.throwIfAborted()
      if (epoch !== this.epoch) throw new Error('OpenCode startup was invalidated by disposal.')
      await this.ensureProcess(signal)
    }), signal)
  }

  private async ensureProcess(signal?: AbortSignal): Promise<void> {
    if (this.cleanupRequired) throw new HarnessExecutionError('OPENCODE_SERVER_CLEANUP_REQUIRED', 'Native shutdown is unconfirmed; explicitly retry disposal or restart before requesting work.')
    if (this.child && this.baseUrl && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        const health = await this.rawRequest('/global/health', { method: 'GET' }, signal)
        try { if (health.ok) return } finally { await health.body?.cancel().catch(() => undefined) }
      } catch (error) {
        // A canceled observer is not evidence of process failure.
        if (signal?.aborted) throw error
      }
      signal?.throwIfAborted()
      await this.stopLiveProcess()
    }
    // A root exit or incomplete startup must not discard an owned process tree.
    if (this.child) await this.stopLiveProcess()
    // Startup belongs to the owner, not to any one request waiting for it.
    await this.start()
  }

  async request(path: string, init: RequestInit = {}, signal?: AbortSignal, expectedGeneration?: number): Promise<Response> {
    await this.ensure(signal)
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
      throw new OpenCodeNativeDeliveryError('OPENCODE_SERVER_GENERATION_CHANGED',
        'OpenCode was replaced; restore and verify native configuration before dispatching work.', 'definite')
    }
    return this.rawRequest(path, init, signal)
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.epoch += 1
    this.startupAbort?.abort(new Error('OpenCode server disposed during startup.'))
    const attempt = this.exclusive(async () => {
      await this.stopLiveProcess()
      this.desiredEnvironment = undefined
      this.references = {}
    })
    this.disposal = attempt
    void attempt.catch(() => { if (this.disposal === attempt) this.disposal = undefined })
    return attempt
  }

  async restart(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void> {
    const next = this.validateEnvironment(environment)
    signal?.throwIfAborted()
    const epoch = this.epoch
    return waitFor(this.exclusive(async () => {
      signal?.throwIfAborted()
      if (epoch !== this.epoch) throw new Error('OpenCode restart was invalidated by disposal.')
      await this.stopLiveProcess()
      // Desired validated credentials survive failed process creation and health checks.
      this.desiredEnvironment = next
      await this.start()
    }), signal)
  }

  private stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const previous = this.stops.get(child)
    if (previous) return previous
    if (this.child === child) { this.cleanupRequired = true; this.baseUrl = undefined }
    const task = (async () => {
      let error: unknown
      const send = async (signal: NodeJS.Signals) => {
        try { await signalTree(child, signal) } catch (cause) { error ??= cause }
      }
      const closed = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve() : new Promise<void>((resolve) => child.once('close', () => resolve()))
      await send('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, PROCESS_SHUTDOWN_GRACE_MS) })])
      } finally { clearTimeout(timer) }
      // Pipe closure or root exit does NOT prove that its descendants exited.
      await send('SIGKILL')
      if (child.exitCode === null && child.signalCode === null) {
        try {
          await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, PROCESS_SHUTDOWN_GRACE_MS) })])
        } finally { clearTimeout(timer) }
      }
      child.stdout.destroy()
      child.stderr.destroy()
      if (child.exitCode === null && child.signalCode === null) {
        error ??= new Error('OpenCode process did not exit after forced shutdown.')
      }
      if (error) throw error
      if (this.child === child) {
        this.child = undefined
        this.password = undefined
        this.cleanupRequired = false
      }
    })()
    this.stops.set(child, task)
    void task.catch(() => { if (this.stops.get(child) === task) this.stops.delete(child) })
    return task
  }

  private async stopLiveProcess(): Promise<void> {
    const child = this.child
    this.baseUrl = undefined
    if (child) await this.stopChild(child)
    // Keep both the child and its credential context when cleanup rejects.
    this.password = undefined
  }

  private async start(): Promise<void> {
    // This controller is reusable only after confirmed cleanup of its last child.
    this.disposal = undefined
    const abort = new AbortController()
    this.startupAbort = abort
    const timer = setTimeout(() => abort.abort(new HarnessExecutionError('OPENCODE_SERVER_START_TIMEOUT',
      'OpenCode did not finish version probing and startup within the startup budget.')), this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)
    try {
      const version = await runCommand(this.options.binary, ['--version'], this.options.workingDirectory, abort.signal)
      abort.signal.throwIfAborted()
      const installed = (version.stdout || version.stderr).trim()
      if (version.exitCode !== 0 || installed !== this.expectedVersion) {
        throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', `OpenCode server mode requires exactly ${this.expectedVersion}; found ${installed || 'unavailable'}.`)
      }
      this.password = randomBytes(32).toString('hex')
      const environment: NodeJS.ProcessEnv = inheritedAgentEnvironment()
      Object.assign(environment, this.desiredEnvironment?.variables ?? {})
      environment.OPENCODE_SERVER_USERNAME = 'opencode'
      environment.OPENCODE_SERVER_PASSWORD = this.password
      this.references = environment.OPENCODE_CONFIG_CONTENT
        ? credentialReferences(parseConfigObject(environment.OPENCODE_CONFIG_CONTENT)) : {}
      if (this.advancedConfiguration) {
        environment.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(environment.OPENCODE_CONFIG_CONTENT, this.advancedConfiguration)
      }
      const pure = this.advancedConfiguration?.plugins.mode === 'pure' || this.options.pure === true
      this.stderr = ''
      const child = spawnNativeProcess(this.options.binary, ['serve', '--hostname', '127.0.0.1', '--port', '0', ...(pure ? ['--pure'] : [])], {
        cwd: this.options.workingDirectory, env: environment,
        ...(this.options.processRecovery ? { recovery: this.options.processRecovery } : {}),
      })
      this.child = child
      child.stdin.on('error', () => undefined)
      child.stdin.end()
      child.stderr.setEncoding('utf8')
      const processSecrets = Object.values(this.desiredEnvironment?.variables ?? {})
      if (this.password) processSecrets.push(this.password, Buffer.from(`opencode:${this.password}`).toString('base64'))
      child.stderr.on('data', (chunk) => {
        this.stderr = redactSecretText(this.stderr + String(chunk), processSecrets).slice(-64_000)
      })
      child.on('error', () => { void this.stopChild(child).catch(() => undefined) })
      child.once('exit', () => { void this.stopChild(child).catch(() => undefined) })
      this.baseUrl = await this.waitForUrl(child, abort.signal)
      child.stdout.resume()
      const response = await this.rawRequest('/global/health', { method: 'GET' }, abort.signal)
      try {
        const health = object(await response.json())
        if (!response.ok || health.healthy !== true || health.version !== this.expectedVersion) {
          throw new HarnessExecutionError('OPENCODE_SERVER_UNHEALTHY', 'The authenticated OpenCode health/version check failed.')
        }
      } finally { await response.body?.cancel().catch(() => undefined) }
      abort.signal.throwIfAborted()
      this.generation += 1
    } catch (error) {
      await this.stopLiveProcess()
      throw error
    } finally {
      clearTimeout(timer)
      this.startupAbort = undefined
    }
  }

  private waitForUrl(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = ''
      const finish = (error?: unknown, url?: string) => {
        signal.removeEventListener('abort', abort)
        child.stdout.removeListener('data', data)
        child.removeListener('error', failed)
        child.removeListener('close', closed)
        if (error) reject(error)
        else resolve(url!)
      }
      const data = (chunk: Buffer | string) => {
        text = (text + String(chunk)).slice(-64_000)
        const match = text.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match?.[1]) finish(undefined, match[1])
      }
      const failed = (error: Error) => finish(error)
      // Do not echo native stderr, which can contain expanded configuration secrets.
      const closed = () => finish(new HarnessExecutionError('OPENCODE_SERVER_START_FAILED', 'OpenCode exited before becoming ready.'))
      const abort = () => finish(signal.reason)
      child.stdout.on('data', data)
      child.once('error', failed)
      child.once('close', closed)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private async rawRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    signal?.throwIfAborted()
    if (!this.baseUrl || !this.password) throw new Error('OpenCode server is not started.')
    const headers = new Headers(init.headers)
    headers.set('authorization', `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`)
    const stream = headers.get('accept') === 'text/event-stream'
    const connection = new AbortController()
    const timeout = stream ? connection.signal : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    // An SSE connection has a header deadline; parseOpenCodeSse owns body heartbeat expiry.
    const timer = stream ? setTimeout(() => connection.abort(new Error('OpenCode event connection timed out.')), REQUEST_TIMEOUT_MS) : undefined
    try { return await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: combined }) }
    finally { clearTimeout(timer) }
  }
}

export function buildOpenCodeConfigContent(inherited: string | undefined, advanced: OpenCodeAdvancedConfiguration): string {
  let base: Record<string, unknown>
  try { base = inherited ? parseConfigObject(inherited) : {} } catch {
    throw new HarnessExecutionError('OPENCODE_CONFIG_CONTENT_INVALID', 'Inherited OPENCODE_CONFIG_CONTENT is not a valid JSONC object.')
  }
  return JSON.stringify({
    ...base,
    compaction: {
      ...object(base.compaction), auto: advanced.compaction.auto, prune: advanced.compaction.prune,
      ...(advanced.compaction.reservedTokens === undefined ? {} : { reserved: advanced.compaction.reservedTokens }),
      ...(advanced.compaction.tailTurns === undefined ? {} : { tail_turns: advanced.compaction.tailTurns }),
      ...(advanced.compaction.preserveRecentTokens === undefined ? {} : { preserve_recent_tokens: advanced.compaction.preserveRecentTokens }),
    },
    ...(advanced.subagentDepth === undefined ? {} : { subagent_depth: advanced.subagentDepth }),
  })
}
