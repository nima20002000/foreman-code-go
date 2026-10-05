import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { AgentFileApplyFormatEditInput, AgentFileCreateWorkingCopyInput,
  AgentFilePublishInput, AgentFileWriteWorkingCopyInput } from '@foreman-code/contracts/files'
import { chatExcludedAppMcpServerNames } from '../appMcpLauncher.js'
import type { FileToolOperation } from '../../files/tools/types.js'
import { fileDeliveryPrompt, nativeImagePart, readPinnedAttachment, readPinnedInput, sha256, type DeliveredAttachment } from './attachments.js'
import { checkFileCondition, OpenCodeFileCleanupError, OpenCodeFileError, type AcceptedOpenCodeFileTurn,
  type OpenCodeAcceptedFileReader, type OpenCodeFilePart, type OpenCodeFileTurnOptions } from './types.js'

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
interface WorkingCopy {
  file: DeliveredAttachment
  writeId: string | undefined
  pendingEdit?: { expectedSha256: string }
}

/** One instance per accepted turn on a dedicated chat server. This helper does not submit prompts.
 * Call submissionAttempted immediately BEFORE prompt_async. Observation loss must not call finish.
 * The native manager must retain its own uncertain-delivery fence and correlate terminal evidence.
 */
export class OpenCodeFileTurn {
  private token: string | undefined
  private connectionToken: string | undefined
  private wakeFileCalls: () => void = () => {}
  private readonly fileCallsReady = new Promise<void>((resolve) => { this.wakeFileCalls = resolve })
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
  private preparation: 'legacy' | 'post_ack' | undefined
  private activationAttempted = false
  private toolsReady = false
  private processClosed = false
  private publicationsAdopted = false
  private toolAdmissionClosed = false

  constructor(private readonly options: OpenCodeFileTurnOptions) {
    checkFileCondition(Number.isSafeInteger(options.maxFileBytes) && options.maxFileBytes > 0
      && Number.isSafeInteger(options.maxAttachments) && options.maxAttachments > 0,
    'FILE_LIMIT_INVALID', 'Contract file and attachment limits are required.')
    const endpoint = new URL(options.endpoint)
    checkFileCondition(!endpoint.username && !endpoint.password && !endpoint.hash && !endpoint.search
      && (endpoint.pathname === '/mcp/files'
        || /^\/mcp\/files\/opencode\/[0-9a-f-]{36}$/.test(endpoint.pathname))
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
    const names = chatExcludedAppMcpServerNames(this.options.appMcpServerName)
    checkFileCondition(object(mcp[this.options.appMcpServerName]).enabled === false,
      'FILE_CHAT_ISOLATION_REQUIRED', 'Workflow App MCP must already be disabled for chat.')
    const status = object(await this.json('/mcp', signal))
    for (const name of names) {
      checkFileCondition((!Object.hasOwn(mcp, name) || object(mcp[name]).enabled === false)
        && (!Object.hasOwn(status, name) || object(status[name]).status === 'disabled'),
      'FILE_CHAT_ISOLATION_REQUIRED', 'Chat cannot acquire workflow or Operator MCP authority.')
    }
  }

  /** Production entry: prepare only pinned, read-only inputs. The range-reader
   * capability comes from authenticated durable admission, NOT from the native
   * model. No token, working-copy mutation or native MCP registration occurs here.
   */
  prepareInputs(admission: AcceptedOpenCodeFileTurn, read: OpenCodeAcceptedFileReader,
    signal: AbortSignal): Promise<PreparedOpenCodeFiles> {
    return this.exclusive(async () => {
      checkFileCondition(!this.closed && !this.toolAdmissionClosed, 'FILE_TURN_CLOSED', 'This file turn is closed.')
      // An empty input set still needs tools for inherited reference reads.
      checkFileCondition(admission.attachments.length <= this.options.maxAttachments,
        'FILE_ATTACHMENT_LIMIT', 'A bounded attachment set is required.')
      checkFileCondition(admission.executionHostId === this.options.host.executionHostId,
        'FILE_EXECUTION_HOST_MISMATCH', 'File delivery requires the accepted execution host.')
      checkFileCondition(admission.mode === (admission.context.allowMutation ? 'write' : 'read'),
        'FILE_SECURITY_CONFLICT', 'File access must match the accepted harness security configuration.')
      checkFileCondition(admission.context.messageId && this.options.adoptPublished,
        'FILE_MESSAGE_BINDING_REQUIRED', 'File chat needs a durable originating message and publication adopter.')
      checkFileCondition(!owners.has(this.options.server) || owners.get(this.options.server) === this,
        'FILE_NATIVE_PROCESS_BUSY', 'Another file turn owns this native process.')
      if (this.accepted) {
        checkFileCondition(this.preparation === 'post_ack' && isDeepStrictEqual(this.accepted, admission),
          'FILE_TURN_CONFLICT', 'The turn was already bound to different file input.')
        checkFileCondition(this.result && (this.options.server.generation ?? 0) === this.generation,
          'FILE_TURN_SETUP_INCOMPLETE', 'File input cannot be regenerated after uncertain delivery.')
        return structuredClone(this.result)
      }
      this.preparation = 'post_ack'
      this.accepted = structuredClone(admission)
      owners.set(this.options.server, this)
      try {
        signal.throwIfAborted()
        await this.options.server.ensure(signal)
        await this.options.host.assertSourceIsolation(signal)
        this.generation = this.options.server.generation ?? 0
        await this.assertChat(signal)
        const delivered: DeliveredAttachment[] = []
        for (const ref of this.accepted.attachments) {
          const pinned = await readPinnedInput(read, ref, this.options.maxFileBytes, signal)
          const handle = randomUUID()
          this.handles.add(handle) // Includes uncertain/partially completed materializations.
          const registered = await this.options.host.materialize({ handle, ...pinned, writable: false }, signal)
          nativeImagePart(registered, pinned.revision, admission.executionHostId)
          delivered.push({ ref, revision: pinned.revision, registered })
        }
        this.result = {
          identity: sha256(JSON.stringify([this.accepted.context, admission.executionHostId, admission.directory,
            delivered.map(({ ref, revision }) => [ref.fileId, ref.revisionId, revision.sha256])])),
          promptSuffix: fileDeliveryPrompt(delivered, admission.mode)
            + (admission.mode === 'write'
              ? '\nInputs are read-only. First use files.create_working_copy; edit only the returned working-copy path.' : ''),
          imageParts: delivered.flatMap(({ registered, revision }) => {
            const part = nativeImagePart(registered, revision, admission.executionHostId)
            return part ? [part] : []
          }),
        }
        return structuredClone(this.result)
      } catch (error) {
        try { await this.release(AbortSignal.timeout(10_000)) }
        catch { throw new OpenCodeFileError('FILE_CLEANUP_REQUIRED', 'File input cleanup needs retry before reuse.') }
        if (error instanceof OpenCodeFileError || signal.aborted) throw error
        throw new OpenCodeFileError('FILE_TURN_SETUP_FAILED', 'The scoped file inputs could not be prepared.')
      }
    })
  }

  /** Observation may prove acknowledgement without retrying failed registration
   * or reviving a deliberately canceled/revoked file session.
   */
  get needsAcknowledgement(): boolean {
    return this.preparation === 'post_ack' && !this.closed && !this.revoked && !this.toolAdmissionClosed
      && !this.token && !this.activationAttempted
      && (this.submission === 'uncertain' || this.submission === 'submitted')
  }

  /** Connect discovery before submitting; this credential cannot access file bytes or mutate artifacts. */
  connectTools(signal: AbortSignal): Promise<void> {
    return this.exclusive(() => this.connectReady(signal))
  }

  private async connectReady(signal: AbortSignal): Promise<void> {
    checkFileCondition(this.result && this.accepted && !this.closed && !this.toolAdmissionClosed,
      'FILE_TURN_CLOSED', 'Prepare the accepted file inputs before connecting tools.')
    if (this.toolsReady) return
    checkFileCondition(!this.connectionToken, 'FILE_NATIVE_SETUP_UNCERTAIN',
      'The file connection did not complete; clean up before another submission.')
    checkFileCondition((this.options.server.generation ?? 0) === this.generation,
      'FILE_NATIVE_PROCESS_CHANGED', 'File discovery belongs to the accepted native process.')
    await this.assertChat(signal)
    this.connectionToken = `gql_file_${randomBytes(32).toString('base64url')}`
    this.options.rememberCredential?.(this.connectionToken)
    await this.connect(signal)
    this.toolsReady = true
  }

  async discover(token: string | undefined, tool?: FileToolOperation) {
    this.assertConnectionCredential(token)
    const caller = await this.options.service.sessions.authorizeAccepted(this.accepted!.context, tool)
    this.assertConnectionCredential(token)
    return caller
  }

  private assertConnectionCredential(token: string | undefined): asserts token is string {
    checkFileCondition(!this.closed && !this.revoked && !this.toolAdmissionClosed && this.accepted && token,
      'FILE_TURN_CLOSED', 'This file connection is unavailable.')
    checkFileCondition(!this.processClosed && (this.options.server.generation ?? 0) === this.generation,
      'FILE_NATIVE_PROCESS_CHANGED', 'The connection belongs to a previous native process.')
    const expected = this.connectionToken ?? this.token
    checkFileCondition(expected && timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(expected)))
      || this.token && timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(this.token))),
    'FILE_CONTEXT_DENIED', 'The file connection belongs to another turn.')
  }

  /** Calls arriving before prompt acknowledgement wait without holding the lifecycle lock. */
  async fileCredential(connectionToken: string | undefined): Promise<string> {
    this.assertConnectionCredential(connectionToken)
    if (!this.token) await this.fileCallsReady
    this.assertConnectionCredential(connectionToken)
    this.assertCredential(this.token)
    return this.token
  }

  /** Only the native manager may enable file calls after positive acknowledgement
   * or persisted user-message evidence. The connection credential never becomes
   * a file-session credential and is not accepted by the shared file endpoint.
   */
  acknowledge(signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      checkFileCondition(!this.closed && !this.revoked && !this.toolAdmissionClosed && this.result && this.accepted
        && this.toolsReady
        && (this.submission === 'uncertain' || this.submission === 'submitted'),
      'FILE_SUBMISSION_INVALID', 'There is no live native submission to acknowledge.')
      this.submission = 'submitted'
      if (this.preparation === 'legacy' || this.token) return
      checkFileCondition(!this.activationAttempted, 'FILE_NATIVE_SETUP_UNCERTAIN',
        'File registration requires explicit recovery; do not reissue the prompt or credential.')
      this.activationAttempted = true
      try {
        signal.throwIfAborted()
        checkFileCondition((this.options.server.generation ?? 0) === this.generation,
          'FILE_NATIVE_PROCESS_CHANGED', 'File tools cannot bind to a replacement native process.')
        await this.assertChat(signal)
        this.token = await this.options.service.sessions.issueForAcceptedSession(this.accepted.context, this.accepted.expiresAt)
        this.options.rememberCredential?.(this.token)
        signal.throwIfAborted()
        checkFileCondition(!this.toolAdmissionClosed, 'FILE_TURN_CLOSED', 'This file turn was stopped during credential issuance.')
        this.wakeFileCalls()
      } catch (error) {
        this.toolAdmissionClosed = true
        this.wakeFileCalls()
        // The prompt is accepted, so keep its input files. Revoke authority even
        // if disconnect failed; a lost observer must never leave usable tools.
        try { await this.revokeReady() }
        catch { throw new OpenCodeFileError('FILE_CLEANUP_REQUIRED', 'File registration failed and credential revocation needs retry.') }
        if (error instanceof OpenCodeFileError || signal.aborted) throw error
        throw new OpenCodeFileError('FILE_NATIVE_SETUP_FAILED', 'The scoped file tools could not be registered.')
      }
    })
  }

  private async connect(signal: AbortSignal): Promise<void> {
    const admission = this.accepted!
    this.serverName = `graphql_files_${sha256(JSON.stringify([
      admission.context.nativeSessionId, admission.context.turnId,
    ])).slice(0, 24)}`
    this.connected = true // A lost reply still requires disconnect/revocation.
    await this.json('/mcp', signal, { name: this.serverName, config: {
      type: 'remote', url: this.options.endpoint, enabled: true, oauth: false,
      headers: { Authorization: `Bearer ${this.connectionToken ?? this.token}` },
    } })
    const status = object(await this.json('/mcp', signal))
    checkFileCondition(object(status[this.serverName]).status === 'connected',
      'FILE_NATIVE_TOOLS_UNAVAILABLE', 'OpenCode did not connect the scoped file tools.')
    await this.assertChat(signal)
  }

  /** Standalone API. Production uses prepareInputs, connectTools and acknowledge. */
  async prepare(admission: AcceptedOpenCodeFileTurn, signal: AbortSignal): Promise<PreparedOpenCodeFiles> {
    return this.exclusive(async () => {
      checkFileCondition(!this.closed && !this.toolAdmissionClosed, 'FILE_TURN_CLOSED', 'This file turn is closed.')
      checkFileCondition(this.preparation !== 'post_ack', 'FILE_TURN_CONFLICT', 'Do not mix the legacy and acknowledged file lifecycles.')
      this.preparation = 'legacy'
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
        this.options.rememberCredential?.(this.token)
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
        await this.connect(signal)
        this.toolsReady = true
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
    checkFileCondition(!this.closed && !this.revoked && !this.toolAdmissionClosed && this.token && token,
      'FILE_TURN_CLOSED', 'This file turn is unavailable.')
    checkFileCondition(!this.processClosed && (this.options.server.generation ?? 0) === this.generation,
      'FILE_NATIVE_PROCESS_CHANGED', 'The credential belongs to a previous native process.')
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
    const writeId = this.preparation === 'legacy'
      ? await this.options.service.artifacts.beginWrite(token, handle) : undefined
    this.handles.add(handle)
    try {
      const registered = await this.options.host.materialize({ handle, ...source, writable: true }, signal)
      nativeImagePart(registered, source.revision, this.accepted!.executionHostId)
      this.copies.set(handle, { writeId, file: { ref: input.source, revision: source.revision, registered, artifactId: handle } })
      return copy
    } catch (error) {
      if (writeId) await this.options.service.artifacts.abortWrite(token, handle, writeId)
      throw error
    }
  }

  createWorkingCopy(token: string, input: AgentFileCreateWorkingCopyInput, signal: AbortSignal) {
    return this.exclusive(() => this.copyReady(token, input, signal))
  }

  writeWorkingCopy(token: string, input: AgentFileWriteWorkingCopyInput) {
    return this.exclusive(async () => {
      const signal = AbortSignal.timeout(120_000)
      checkFileCondition(this.options.service.writeWorkingCopy, 'FILE_TOOL_DENIED', 'Working-copy writes are unavailable.')
      const nativeBytes = await this.importWorkingCopy(token, input.artifactId, signal)
      this.copies.get(input.artifactId)!.pendingEdit = { expectedSha256: sha256(nativeBytes) }
      const result = await this.options.service.writeWorkingCopy(token, input)
      await this.synchronizeWorkingCopy(token, input.artifactId, signal)
      return result
    })
  }

  applyFormatEdit(token: string, input: AgentFileApplyFormatEditInput) {
    return this.exclusive(async () => {
      const signal = AbortSignal.timeout(120_000)
      checkFileCondition(this.options.service.applyFormatEdit, 'FILE_TOOL_DENIED', 'Format edits are unavailable.')
      const nativeBytes = await this.importWorkingCopy(token, input.artifactId, signal)
      this.copies.get(input.artifactId)!.pendingEdit = { expectedSha256: sha256(nativeBytes) }
      const result = await this.options.service.applyFormatEdit(token, input)
      await this.synchronizeWorkingCopy(token, input.artifactId, signal)
      return result
    })
  }

  workingCopyLocation(token: string, artifactId: string): Promise<string> {
    return this.exclusive(async () => {
      await this.authorize(token)
      const copy = this.copies.get(artifactId)
      checkFileCondition(copy, 'FILE_ARTIFACT_NOT_FOUND', 'The artifact is not registered for this native turn.')
      await this.synchronizeWorkingCopy(token, artifactId, AbortSignal.timeout(120_000))
      return copy.file.registered.path
    })
  }

  private async synchronizeWorkingCopy(token: string, artifactId: string, signal: AbortSignal): Promise<void> {
    const copy = this.copies.get(artifactId)!
    if (!copy.pendingEdit) return
    const caller = await this.authorize(token, true)
    const edited = await this.options.service.artifacts.readSnapshot(caller, artifactId, signal)
    if (edited.revision.sha256 === copy.pendingEdit.expectedSha256) {
      delete copy.pendingEdit
      return
    }
    if (sha256(await this.options.host.snapshot(artifactId, signal)) === edited.revision.sha256) {
      delete copy.pendingEdit
      return
    }
    await this.authorize(token, true)
    await this.options.host.replace(artifactId, edited.bytes, copy.pendingEdit.expectedSha256, signal)
    delete copy.pendingEdit
  }

  private async importWorkingCopy(token: string, artifactId: string, signal: AbortSignal): Promise<Uint8Array> {
    const caller = await this.authorize(token, true)
    const copy = this.copies.get(artifactId)
    checkFileCondition(copy, 'FILE_ARTIFACT_NOT_FOUND', 'Edit or publish a registered working copy.')
    await this.synchronizeWorkingCopy(token, artifactId, signal)
    const bytes = await this.options.host.snapshot(artifactId, signal)
    checkFileCondition(bytes.byteLength <= this.options.maxFileBytes,
      'FILE_ARTIFACT_TOO_LARGE', 'The completed working copy exceeds the file limit.')
    const artifact = await this.options.service.artifacts.get(caller, artifactId)
    if (artifact.state === 'writing') checkFileCondition(copy.writeId === artifact.writeId,
      'FILE_ARTIFACT_BUSY', 'Another trusted runner owns the artifact write lease.')
    if (artifact.state === 'complete' && artifact.snapshot?.revision.sha256 === sha256(bytes)) return bytes
    const writeId = artifact.state === 'writing' ? artifact.writeId
      : await this.options.service.artifacts.beginWrite(token, artifactId)
    copy.writeId = writeId
    await this.options.service.artifacts.completeWrite(token, artifactId, writeId, Readable.from([bytes]), signal)
    copy.writeId = undefined
    return bytes
  }

  publish(token: string, input: AgentFilePublishInput, signal: AbortSignal) {
    return this.exclusive(async () => {
      await this.authorize(token, true)
      checkFileCondition(isDeepStrictEqual(input.scope, this.accepted!.context.scope),
        'FILE_CONTEXT_DENIED', 'Publish only to the originating temporary conversation.')
      await this.importWorkingCopy(token, input.artifactId, signal)
      // FIL-05 reauthorizes source pins, hashes content for commandId conflicts and links the turn.
      this.publicationsAdopted = false
      const result = await this.options.service.publish(token, input)
      await this.adoptReady()
      return result
    })
  }

  /** Must precede submission, not follow its acknowledgement. */
  submissionAttempted(): void {
    checkFileCondition(this.result && this.toolsReady && !this.closed && this.submission === 'not_submitted',
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
    // Close the in-process facade immediately, even when persistent revoke fails.
    // Do not let an invalid definite-rejection request close an accepted turn.
    if (evidence === 'terminal' || this.submission !== 'submitted') this.toolAdmissionClosed = true
    if (this.toolAdmissionClosed) this.wakeFileCalls()
    return this.exclusive(async () => {
      checkFileCondition(evidence !== 'definite_rejection' || this.submission !== 'submitted',
        'FILE_SUBMISSION_INVALID', 'A positively accepted submission cannot become a definite rejection.')
      if (evidence === 'terminal') this.submission = 'terminal'
      this.releaseAuthorized = true
      // Publication adoption is retryable by the exact durable binding, without
      // keeping an otherwise-terminal native credential alive on a DB failure.
      const errors: unknown[] = []
      let cleanup: OpenCodeFileCleanupError | undefined
      try {
        await this.release(signal)
      } catch (error) {
        if (error instanceof OpenCodeFileCleanupError) cleanup = error
        else errors.push(error)
      }
      if (evidence === 'terminal') try { await this.adoptReady() } catch (error) { errors.push(error) }
      if (errors.length) {
        if (cleanup) errors.push(cleanup)
        throw new AggregateError(errors, 'File turn finalization needs retry.')
      }
      if (cleanup) throw cleanup
    })
  }

  private async adoptReady(): Promise<void> {
    if (this.publicationsAdopted || !this.accepted || !this.options.adoptPublished) return
    await this.options.adoptPublished(structuredClone(this.accepted.context))
    this.publicationsAdopted = true
  }

  private async revokeReady(): Promise<void> {
    if (this.token && !this.revoked) {
      await this.options.service.sessions.revoke(this.token)
      this.revoked = true
    }
  }

  /** Cancel/stop closes tool admission before aborting native work. Input files
   * remain owned until terminal evidence or a positively closed process exists.
   */
  revoke(): Promise<void> {
    this.toolAdmissionClosed = true
    this.wakeFileCalls()
    return this.exclusive(() => this.revokeReady())
  }

  /** Resource closure is not terminal-result evidence. Call ONLY after the
   * owned native process is positively closed. Never restart it to disconnect MCP.
   */
  nativeProcessClosed(signal: AbortSignal): Promise<void> {
    this.toolAdmissionClosed = true
    this.wakeFileCalls()
    return this.exclusive(async () => {
      this.processClosed = true
      this.releaseAuthorized = true
      this.connected = false
      const errors: unknown[] = []
      try { await this.release(signal) } catch (error) { errors.push(error) }
      try { await this.adoptReady() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Closed-process file cleanup needs retry.')
    })
  }

  /** Retry cleanup without creating a new credential, replacing a path or submitting native input. */
  retryCleanup(signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      checkFileCondition(this.releaseAuthorized || this.submission === 'not_submitted',
        'FILE_SUBMISSION_FENCED', 'An unresolved native turn still owns its files.')
      const errors: unknown[] = []
      try { await this.release(signal) } catch (error) { errors.push(error) }
      if (this.submission === 'terminal' || this.processClosed) {
        try { await this.adoptReady() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'File cleanup and publication adoption need retry.')
    })
  }

  private async release(signal: AbortSignal): Promise<void> {
    this.publicationsAdopted = false
    if (!this.closed) {
      await this.revokeReady()
      if (this.connected && this.serverName) {
        await this.json(`/mcp/${encodeURIComponent(this.serverName)}/disconnect`, signal, {})
        this.connected = false
      }
      this.copies.clear()
      this.closed = true
      this.token = undefined
      this.connectionToken = undefined
      this.wakeFileCalls()
      if (owners.get(this.options.server) === this) owners.delete(this.options.server)
    }
    const errors: unknown[] = []
    for (const handle of this.handles) {
      try {
        await this.options.host.remove(handle)
        this.handles.delete(handle)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new OpenCodeFileCleanupError(errors)
  }
}
