import { HarnessExecutionError } from './errors.js'
import { spawnOwnedStdioProcess } from './process.js'
import { redactKnownSecrets, redactSecretText } from './secrets.js'

export type JsonObject = Record<string, unknown>
export type RequestId = string | number
export interface RpcRequest { id: RequestId; method: string; params?: JsonObject }
export interface CodexProtocol {
  request(message: RpcRequest): void
  notification(message: JsonObject): void
  serverRequest(message: RpcRequest): void
  response(method: string, value: unknown): void
  serverResponse(method: string, value: unknown): void
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
export function object(value: unknown, code = 'CODEX_PROTOCOL_INVALID'): JsonObject {
  if (!isObject(value)) throw new HarnessExecutionError(code, 'Codex returned an invalid structured response.')
  return value
}

export class CodexRpcError extends HarnessExecutionError {
  constructor(
    readonly method: string,
    readonly operationId: RequestId,
    readonly uncertain: boolean,
    code: string,
    readonly nativeMessage?: string,
  ) {
    super(code, uncertain
      ? `The outcome of ${method} is uncertain; reconcile the operation before retrying.`
      : `Codex did not accept ${method}.`)
  }
}

interface Operation {
  method: string
  submitted: boolean
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
  late?: (value: unknown, error?: Error) => void
}
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const MAX_OPERATIONS = 256

/** All stream and dispatch failures end at this boundary, never at EventEmitter. */
export class CodexStdioTransport {
  private owned?: ReturnType<typeof spawnOwnedStdioProcess>
  private readonly operations = new Map<RequestId, Operation>()
  private readonly uncertainOperations = new Map<RequestId, Operation>()
  private readonly writes = new Set<(error: Error) => void>()
  private nextId = 1
  private stopped = false
  private closePromise?: Promise<void>
  private stderr = ''

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly protocol: CodexProtocol,
    private readonly onRequest: (request: RpcRequest) => Promise<void>,
    private readonly onNotification: (method: string, params: JsonObject) => void,
    private readonly onDisconnect: (error: Error) => void,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.owned || this.stopped) throw new HarnessExecutionError('CODEX_TRANSPORT_REUSED', 'Create a new provider transport.')
    this.owned = spawnOwnedStdioProcess({
      binary: this.binary, args: ['app-server', '--stdio'], cwd: this.cwd, environment: this.environment,
      onError: (error) => this.fail(error),
    })
    const { child, closed } = this.owned
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = redactSecretText(this.stderr + chunk, [this.environment.GRAPHQL_APP_MCP_TOKEN ?? '']).slice(-128_000)
    })
    void this.readFrames().catch((error: unknown) => this.fail(error instanceof Error ? error : new Error('Codex dispatch failed.')))
    void closed.then(() => this.fail(new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Codex app-server disconnected.')))
    try {
      await this.request('initialize', {
        clientInfo: { name: 'graphql', title: 'GraphQL', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      }, signal)
      await this.write({ method: 'initialized' })
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async request(
    method: string, params?: JsonObject, signal?: AbortSignal,
    late?: (value: unknown, error?: Error) => void,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    this.assertConnected()
    const id = this.nextId++
    const message: RpcRequest = { id, method, ...(params === undefined ? {} : { params }) }
    this.protocol.request(message)
    if (this.operations.size + this.uncertainOperations.size >= MAX_OPERATIONS) {
      throw new HarnessExecutionError('CODEX_OPERATION_LIMIT', 'Too many unresolved provider operations; reconcile before submitting more.')
    }
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => this.settleFailure(id, 'CODEX_APP_SERVER_REQUEST_CANCELED')
      const timer = setTimeout(() => this.settleFailure(id, 'CODEX_APP_SERVER_TIMEOUT'), this.timeoutMs)
      const operation: Operation = {
        method, resolve, reject, submitted: false, ...(late ? { late } : {}),
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
      }
      this.operations.set(id, operation)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      // Once write is attempted, neither EPIPE nor abort proves non-delivery.
      operation.submitted = true
      try {
        this.owned!.child.stdin.write(JSON.stringify(message) + '\n', (error) => {
          if (error) this.settleFailure(id, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN')
        })
      } catch {
        this.settleFailure(id, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN')
      }
    })
  }

  async respond(id: RequestId, method: string, result: JsonObject): Promise<void> {
    try { this.protocol.serverResponse(method, result) } catch {
      throw new HarnessExecutionError('NATIVE_RESPONSE_INVALID', 'The response does not match the qualified native schema; nothing was submitted.')
    }
    this.assertConnected('NATIVE_RESPONSE_DELIVERY_FAILED')
    try { await this.write({ id, result }) } catch {
      throw new HarnessExecutionError('NATIVE_RESPONSE_DELIVERY_UNCERTAIN', 'The native response may have been submitted; wait for native resolution before retrying.')
    }
  }

  async reject(id: RequestId, code: number, message: string): Promise<void> {
    await this.write({ id, error: { code, message } })
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.stop(new HarnessExecutionError('CODEX_APP_SERVER_CLOSED', 'Codex transport was closed.'))
    this.closePromise = this.owned?.close() ?? Promise.resolve()
    return this.closePromise
  }

  private assertConnected(code = 'CODEX_APP_SERVER_DISCONNECTED'): void {
    if (this.stopped || !this.owned || this.owned.child.stdin.destroyed) {
      throw new HarnessExecutionError(code, 'Codex app-server is not connected.')
    }
  }

  private write(message: JsonObject): Promise<void> {
    this.assertConnected()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.writes.delete(failed)
        if (error) reject(error)
        else resolve()
      }
      const failed = (error: Error) => finish(error)
      const timer = setTimeout(() => finish(new Error('Provider write timed out.')), this.timeoutMs)
      this.writes.add(failed)
      try { this.owned!.child.stdin.write(JSON.stringify(message) + '\n', finish) } catch (error) {
        finish(error instanceof Error ? error : new Error('Provider write failed.'))
      }
    })
  }

  private settleFailure(id: RequestId, code: string): void {
    const operation = this.operations.get(id)
    if (!operation) return
    this.operations.delete(id)
    operation.cleanup()
    if (operation.submitted) this.uncertainOperations.set(id, operation)
    operation.reject(new CodexRpcError(operation.method, id, operation.submitted, code))
  }

  private async readFrames(): Promise<void> {
    const stdout = this.owned!.child.stdout
    stdout.setEncoding('utf8')
    let pending = ''
    for await (const chunk of stdout) {
      if (this.stopped) break
      pending += String(chunk)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Codex stdout frame exceeded its limit.')
        if (line.trim()) await this.receive(line)
        if (this.stopped) return
      }
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) throw new Error('Codex stdout frame exceeded its limit.')
    }
    if (pending && !this.stopped) this.onNotification('protocol/malformed', { reason: 'incomplete_frame' })
  }

  private async receive(line: string): Promise<void> {
    let message: unknown
    try { message = redactKnownSecrets(JSON.parse(line), [this.environment.GRAPHQL_APP_MCP_TOKEN ?? '']) } catch {
      this.onNotification('protocol/malformed', { reason: 'invalid_json' }); return
    }
    if (!isObject(message)) { this.onNotification('protocol/malformed', { reason: 'invalid_envelope' }); return }
    const id = typeof message.id === 'string' || (typeof message.id === 'number' && Number.isSafeInteger(message.id)) ? message.id : undefined
    const method = text(message.method)
    if ((typeof id === 'string' && id.length > 1_024) || (method && method.length > 256)) {
      this.onNotification('protocol/malformed', { reason: 'identity_size_limit' }); return
    }
    if (id !== undefined && method) {
      const request: RpcRequest = { id, method, ...(isObject(message.params) ? { params: message.params } : {}) }
      try {
        this.protocol.serverRequest(request)
        await this.onRequest(request)
      } catch {
        // Never echo untrusted native payloads or secrets in errors.
        await this.reject(id, -32602, 'Invalid or unsupported native interaction.').catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error('Native request rejection failed.'))
        })
        this.onNotification('protocol/malformed', { reason: 'invalid_request', nativeMethod: method })
      }
      return
    }
    if (id !== undefined) {
      const operation = this.operations.get(id) ?? this.uncertainOperations.get(id)
      if (!operation) return
      const wasLate = this.uncertainOperations.has(id)
      let error: Error | undefined
      if (isObject(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
        error = new CodexRpcError(operation.method, id, false, 'CODEX_APP_SERVER_REQUEST_FAILED', message.error.message)
      } else {
        try {
          if (!Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new Error('Malformed response.')
          this.protocol.response(operation.method, message.result)
        } catch {
          this.settleFailure(id, 'CODEX_APP_SERVER_RESPONSE_INVALID')
          this.onNotification('protocol/malformed', { reason: 'invalid_response', nativeMethod: operation.method })
          return
        }
      }
      this.operations.delete(id)
      this.uncertainOperations.delete(id)
      operation.cleanup()
      if (wasLate) operation.late?.(message.result, error)
      else if (error) operation.reject(error)
      else operation.resolve(message.result)
      return
    }
    if (method) {
      try { this.protocol.notification(message) } catch {
        this.onNotification('protocol/malformed', { reason: 'invalid_notification', nativeMethod: method }); return
      }
      this.onNotification(method, isObject(message.params) ? message.params : {})
    } else this.onNotification('protocol/malformed', { reason: 'invalid_envelope' })
  }

  private stop(error: Error): boolean {
    if (this.stopped) return false
    this.stopped = true
    for (const id of this.operations.keys()) this.settleFailure(id, 'CODEX_APP_SERVER_DISCONNECTED')
    for (const failed of [...this.writes]) failed(error)
    this.writes.clear()
    return true
  }

  private fail(error: Error): void {
    if (!this.stop(error)) return
    try { this.onDisconnect(error) } catch { /* Observer failure cannot escape this process boundary. */ }
    void this.close().catch(() => undefined)
  }
}
