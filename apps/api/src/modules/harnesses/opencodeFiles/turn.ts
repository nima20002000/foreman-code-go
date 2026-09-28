import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { AgentFileCreateWorkingCopyInput, AgentFilePublishInput } from '@graphql/contracts/files'
import { fileDeliveryPrompt, nativeImagePart, readPinnedAttachment, sha256, type DeliveredAttachment } from './attachments.js'
import { checkFileCondition, OpenCodeFileError, type AcceptedOpenCodeFileTurn,
  type OpenCodeFilePart, type OpenCodeFileTurnOptions } from './types.js'

const owners = new WeakMap<object, OpenCodeFileTurn>()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const withDirectory = (path: string, directory: string) => `${path}?directory=${encodeURIComponent(directory)}`

export interface PreparedOpenCodeFiles {
  /** Append to THIS turn's user text only. Never put this in startup/system instructions. */
  promptSuffix: string
  imageParts: readonly OpenCodeFilePart[]
  /** Incorporate in the durable request/turn identity. No token is included. */
  identity: string
}
interface WorkingCopy { file: DeliveredAttachment; writeId: string | undefined }

/** One instance per accepted turn on a dedicated chat server. This helper does not submit prompts.
 * Call submissionAttempted immediately BEFORE prompt_async. Observation loss must not call finish.
 * The native manager must retain its own uncertain-delivery fence and correlate terminal evidence.
 */
export class OpenCodeFileTurn {
  private token: string | undefined
  private accepted: AcceptedOpenCodeFileTurn | undefined
  private generation: number | undefined
  private serverName: string | undefined
  private result: PreparedOpenCodeFiles | undefined
  private copies = new Map<string, WorkingCopy>()
  private handles = new Set<string>()
  private lifecycle: Promise<unknown> = Promise.resolve()
  private submission: 'not_submitted' | 'uncertain' | 'submitted' | 'terminal' = 'not_submitted'
  private closed = false
  private revoked = false
  private connected = false
  private releaseAuthorized = false

  constructor(private readonly options: OpenCodeFileTurnOptions) {
    checkFileCondition(Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes > 0
      && Number.isSafeInteger(options.maxAttachments) && options.maxAttachments > 0,
    'FILE_LIMIT_INVALID', 'Contract file and attachment limits are required.')
    const endpoint = new URL(options.endpoint)
    checkFileCondition(!endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search
      && endpoint.pathname === '/mcp/files'
      && (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:'
        && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname))),
    'FILE_MCP_ENDPOINT_INVALID', 'Use the trusted file-only endpoint over TLS or loopback.')
    checkFileCondition(options.appMcpServerName.length > 0, 'FILE_CHAT_ISOLATION_REQUIRED',
      'The workflow App MCP identity is required.')
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(work)
    this.lifecycle = next.catch(() => undefined)
    return next
  }

  private async json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const accepted = this.accepted!
    const response = await this.options.server.request(withDirectory(path, accepted.directory), {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }, signal, this.generation)
    // Never include native bodies, endpoint configuration or Authorization values in errors.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new OpenCodeFileError('FILE_NATIVE_SETUP_FAILED', 'OpenCode rejected file-session setup.')
    }
    const chunks: Uint8Array[] = []
    const reader = response.body?.getReader()
    let length = 0
    try {
      if (reader) while (true) {
        signal.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        checkFileCondition(length <= 1_048_576, 'FILE_NATIVE_RESPONSE_INVALID', 'OpenCode returned excessive configuration data.')
        chunks.push(next.value)
      }
    } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    try { return text ? JSON.parse(text) : undefined }
    catch { throw new OpenCodeFileError('FILE_NATIVE_RESPONSE_INVALID', 'OpenCode returned invalid configuration data.') }
  }

  private async assertChat(signal: AbortSignal): Promise<void> {
    const config = object(await this.json('/config', signal))
    const mcp = object(config.mcp)
    const names = new Set([this.options.appMcpServerName, 'graphql', 'graphql-app', 'graphql-operator'])
    checkFileCondition(object(mcp[this.options.appMcpServerName]).enabled === false,
      'FILE_CHAT_ISOLATION_REQUIRED', 'Workflow App MCP must already be disabled for chat.')
    const status = object(await this.json('/mcp', signal))
    for (const name of names) {
      checkFileCondition((!Object.hasOwn(mcp, name) || object(mcp[name]).enabled === false)
        && (!Object.hasOwn(status, name) || object(status[name]).status === 'disabled'),
      'FILE_CHAT_ISOLATION_REQUIRED', 'Chat cannot acquire workflow or Operator MCP authority.')
    }
  }

  async prepare(admission: AcceptedOpenCodeFileTurn, signal: AbortSignal): Promise<PreparedOpenCodeFiles> {
    return this.exclusive(async () => {
      checkFileCondition(!this.closed, 'FILE_TURN_CLOSED', 'This file turn is closed.')
      checkFileCondition(admission.attachments.length <= this.options.maxAttachments,
        'FILE_ATTACHMENT_LIMIT', 'Too many attachments.')
      checkFileCondition(admission.executionHostId === this.options.host.executionHostId,
        'FILE_EXECUTION_HOST_MISMATCH', 'File delivery requires the accepted execution host.')
      checkFileCondition(admission.mode === (admission.context.allowMutation ? 'write' : 'read'),
        'FILE_SECURITY_CONFLICT', 'File access must match the accepted harness security configuration.')
      checkFileCondition(!owners.has(this.options.server) || owners.get(this.options.server) === this,
        'FILE_NATIVE_PROCESS_BUSY', 'Another file turn owns this native process.')
      if (this.accepted) {
        checkFileCondition(isDeepStrictEqual(this.accepted.context, admission.context)
          && isDeepStrictEqual(this.accepted.attachments, admission.attachments)
          && this.accepted.mode === admission.mode && this.accepted.directory === admission.directory
          && this.accepted.executionHostId === admission.executionHostId,
        'FILE_TURN_CONFLICT', 'The turn was already bound to different file input.')
        checkFileCondition(this.result, 'FILE_TURN_SETUP_INCOMPLETE', 'File setup did not complete; do not replay the native prompt.')
        await this.options.service.sessions.authenticate(this.token, 'files.read')
        return structuredClone(this.result)
      }
      owners.set(this.options.server, this)
      this.accepted = structuredClone(admission)
      try {
        signal.throwIfAborted()
        await this.options.host.assertSourceIsolation(signal)
        await this.options.server.ensure(signal)
        this.generation = this.options.server.generation ?? 0
        await this.assertChat(signal)
        // Native identity and scope are already durable; never issue from tool arguments.
        this.token = await this.options.service.sessions.issueForAcceptedSession(admission.context, admission.expiresAt)
        const delivered: DeliveredAttachment[] = []
        for (const ref of admission.attachments) {
          const pinned = await readPinnedAttachment(this.options.service, this.token, ref, this.options.maxFileBytes, signal)
          if (admission.mode === 'write') {
            const copy = await this.copyReady(this.token, { commandId: `fil09:${sha256(JSON.stringify([
              admission.context.nativeSessionId, admission.context.turnId, ref.fileId, ref.revisionId,
            ]))}`, source: ref, destination: admission.context.scope }, signal, pinned)
            delivered.push(this.copies.get(copy.value.artifactId)!.file)
          } else {
            const handle = randomUUID()
            this.handles.add(handle)
            const registered = await this.options.host.materialize({ handle, ...pinned, writable: false }, signal)
            nativeImagePart(registered, pinned.revision, admission.executionHostId)
            delivered.push({ ref, revision: pinned.revision, registered })
          }
        }
        const identity = sha256(JSON.stringify([admission.context, admission.executionHostId, admission.directory,
          delivered.map(({ ref, revision }) => [ref.fileId, ref.revisionId, revision.sha256])]))
        this.serverName = `graphql_files_${sha256(JSON.stringify([
          admission.context.nativeSessionId, admission.context.turnId,
        ])).slice(0, 24)}`
        // Dynamic remote MCP setup is resident-instance scoped, never a saved user config edit.
        this.connected = true // An uncertain /mcp reply still requires disconnect/revocation.
        await this.json('/mcp', signal, { name: this.serverName, config: {
          type: 'remote', url: this.options.endpoint, enabled: true, oauth: false,
          headers: { Authorization: `Bearer ${this.token}` },
        } })
        const status = object(await this.json('/mcp', signal))
        checkFileCondition(object(status[this.serverName]).status === 'connected',
          'FILE_NATIVE_TOOLS_UNAVAILABLE', 'OpenCode did not connect the scoped file tools.')
        await this.assertChat(signal)
        this.result = { identity, promptSuffix: fileDeliveryPrompt(delivered, admission.mode),
          imageParts: delivered.flatMap(({ registered, revision }) => {
            const part = nativeImagePart(registered, revision, admission.executionHostId)
            return part ? [part] : []
          }) }
        return structuredClone(this.result)
      } catch (error) {
        // No prompt was sent by this helper. Preserve a failed revoke fence rather than hiding it.
        try { await this.release(AbortSignal.timeout(10_000)) }
        catch { throw new OpenCodeFileError('FILE_CLEANUP_REQUIRED', 'File setup failed and cleanup needs retry before reuse.') }
        if (error instanceof OpenCodeFileError || signal.aborted) throw error
        throw new OpenCodeFileError('FILE_TURN_SETUP_FAILED', 'The scoped file turn could not be prepared.')
      }
    })
  }

  /** Used only by the per-turn file MCP facade; never serialize this credential. */
  assertCredential(token: string | undefined): asserts token is string {
    checkFileCondition(!this.closed && !this.revoked && this.token && token,
      'FILE_TURN_CLOSED', 'This file turn is unavailable.')
    checkFileCondition(timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(this.token))),
      'FILE_CONTEXT_DENIED', 'The file credential belongs to another turn.')
  }

  async publications() {
    this.assertCredential(this.token)
    return this.options.service.publishedForTurn(this.token)
  }

  private async authorize(token: string, mutation = false) {
    checkFileCondition(!this.closed && !this.revoked && this.token && this.accepted,
      'FILE_TURN_CLOSED', 'This file turn is unavailable.')
    this.assertCredential(token)
    checkFileCondition(!mutation || this.accepted.mode === 'write', 'FILE_TOOL_DENIED', 'The accepted harness is read-only.')
    const caller = await this.options.service.sessions.authenticate(token, mutation ? 'files.publish_result' : 'files.read')
    checkFileCondition((this.options.server.generation ?? 0) === this.generation,
      'FILE_NATIVE_PROCESS_CHANGED', 'Rebind files after native process recovery; never replay the prompt.')
    return caller
  }

  private async copyReady(token: string, input: AgentFileCreateWorkingCopyInput, signal: AbortSignal,
    pinned?: Awaited<ReturnType<typeof readPinnedAttachment>>) {
    await this.authorize(token, true)
    checkFileCondition(isDeepStrictEqual(input.destination, this.accepted!.context.scope),
      'FILE_CONTEXT_DENIED', 'Working copies belong only to the originating temporary conversation.')
    const copy = await this.options.service.createWorkingCopy(token, input)
    if (this.copies.has(copy.value.artifactId)) return copy
    const source = pinned ?? await readPinnedAttachment(this.options.service, token, input.source, this.options.maxFileBytes, signal)
    const handle = copy.value.artifactId
    const writeId = await this.options.service.artifacts.beginWrite(token, handle)
    this.handles.add(handle)
    try {
      const registered = await this.options.host.materialize({ handle, ...source, writable: true }, signal)
      nativeImagePart(registered, source.revision, this.accepted!.executionHostId)
      this.copies.set(handle, { writeId, file: { ref: input.source, revision: source.revision, registered, artifactId: handle } })
      return copy
    } catch (error) {
      await this.options.service.artifacts.abortWrite(token, handle, writeId)
      throw error
    }
  }

  createWorkingCopy(token: string, input: AgentFileCreateWorkingCopyInput, signal: AbortSignal) {
    return this.exclusive(() => this.copyReady(token, input, signal))
  }

  async workingCopyLocation(token: string, artifactId: string): Promise<string> {
    await this.authorize(token)
    const copy = this.copies.get(artifactId)
    checkFileCondition(copy, 'FILE_ARTIFACT_NOT_FOUND', 'The artifact is not registered for this native turn.')
    return copy.file.registered.path
  }

  publish(token: string, input: AgentFilePublishInput, signal: AbortSignal) {
    return this.exclusive(async () => {
      const caller = await this.authorize(token, true)
      checkFileCondition(isDeepStrictEqual(input.scope, this.accepted!.context.scope),
        'FILE_CONTEXT_DENIED', 'Publish only to the originating temporary conversation.')
      const copy = this.copies.get(input.artifactId)
      checkFileCondition(copy, 'FILE_ARTIFACT_NOT_FOUND', 'Publish a registered working copy, not an arbitrary host path.')
      const artifact = await this.options.service.artifacts.get(caller, input.artifactId)
      if (artifact.state === 'writing') checkFileCondition(copy.writeId === artifact.writeId,
        'FILE_ARTIFACT_BUSY', 'Another trusted runner owns the artifact write lease.')
      const writeId = artifact.state === 'writing' ? artifact.writeId
        : await this.options.service.artifacts.beginWrite(token, input.artifactId)
      copy.writeId = writeId
      const bytes = await this.options.host.snapshot(input.artifactId, signal)
      checkFileCondition(bytes.byteLength <= this.options.maxFileBytes,
        'FILE_ARTIFACT_TOO_LARGE', 'The completed working copy exceeds the file limit.')
      await this.options.service.artifacts.completeWrite(token, input.artifactId, writeId,
        Readable.from([bytes]), signal)
      copy.writeId = undefined
      // FIL-05 reauthorizes source pins, hashes content for commandId conflicts and links the turn.
      return this.options.service.publish(token, input)
    })
  }

  /** Must precede submission, not follow its acknowledgement. */
  submissionAttempted(): void {
    checkFileCondition(this.result && !this.closed && this.submission === 'not_submitted',
      'FILE_SUBMISSION_FENCED', 'An accepted or uncertain native prompt must not be resubmitted.')
    this.submission = 'uncertain'
  }
  submissionAcknowledged(): void {
    checkFileCondition(this.submission === 'uncertain', 'FILE_SUBMISSION_INVALID', 'No native submission is being acknowledged.')
    this.submission = 'submitted'
  }

  /** Only exact native terminal evidence or a definite rejection authorizes cleanup.
   * A canceled HTTP/SSE observer, missing message, timeout, or process exit is NOT this evidence.
   */
  finish(evidence: 'terminal' | 'definite_rejection', signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      checkFileCondition(evidence !== 'definite_rejection' || this.submission !== 'submitted',
        'FILE_SUBMISSION_INVALID', 'A positively accepted submission cannot become a definite rejection.')
      if (evidence === 'terminal') this.submission = 'terminal'
      this.releaseAuthorized = true
      await this.release(signal)
    })
  }

  /** Retry cleanup without creating a new credential, replacing a path or submitting native input. */
  retryCleanup(signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      checkFileCondition(this.releaseAuthorized || this.submission === 'not_submitted',
        'FILE_SUBMISSION_FENCED', 'An unresolved native turn still owns its files.')
      await this.release(signal)
    })
  }

  private async release(signal: AbortSignal): Promise<void> {
    if (this.closed) return
    if (this.token && !this.revoked) {
      await this.options.service.sessions.revoke(this.token)
      this.revoked = true
    }
    if (this.connected && this.serverName) {
      await this.json(`/mcp/${encodeURIComponent(this.serverName)}/disconnect`, signal, {})
      this.connected = false
    }
    for (const handle of this.handles) {
      await this.options.host.remove(handle)
      this.handles.delete(handle)
    }
    this.copies.clear()
    this.closed = true
    this.token = undefined
    if (owners.get(this.options.server) === this) owners.delete(this.options.server)
  }
}
