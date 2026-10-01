/** Narrow injectable boundary for the pinned official streaming SDK. */
export interface ClaudeSdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  uuid: string
}

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>
  /** First-connect answer only; does not resend initialize or offer input. */
  initializationResult?(): Promise<unknown>
  mcpServerStatus?(): Promise<readonly unknown[]>
  setMcpServers?(servers: Readonly<Record<string, unknown>>): Promise<unknown>
  close(): void
  /** Positive process containment closure supplied by the owned host adapter. */
  joinClosed?(): Promise<void>
}

export interface ClaudeSdkClient {
  readonly sdkVersion: string
  query(input: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: Readonly<Record<string, unknown>> }): ClaudeSdkQuery
  getSessionInfo(sessionId: string, options: { dir: string }): Promise<{ sessionId: string } | undefined>
  getSessionMessages(sessionId: string, options: { dir: string; limit?: number; offset?: number }): Promise<readonly unknown[]>
  forkSession(sessionId: string, options: { dir: string }): Promise<{ sessionId: string }>
}

export interface ClaudeSessionScope {
  readonly deviceId: string
  readonly profilePath: string
  readonly configRevision: string
  readonly cwd: string
}

export interface ClaudePersistedSession extends ClaudeSessionScope {
  readonly nativeSessionId: string
}

export interface ClaudeNativeObservation {
  nativeSessionId: string
  /** Native output frame identity, never an application/native turn ID. */
  providerMessageId?: string
  /** Client UUIDs positively echoed by native output; not native IDs. */
  promptUuids: readonly string[]
  kind: 'reply' | 'result'
}

export interface ClaudeSdkOutput {
  raw: unknown
  observation?: ClaudeNativeObservation
}

export interface ClaudeSdkOpenInput {
  scope: ClaudeSessionScope
  options: Readonly<Record<string, unknown>>
  resume?: ClaudePersistedSession
  signal?: AbortSignal
  /** Persistence completes before the corresponding output is exposed. */
  onObservation?(observation: ClaudeNativeObservation): Promise<void>
  /** Stop process-local permission/question callbacks, including before init. */
  cancelPendingRequests?(): void
}

export interface ClaudeSdkSession {
  readonly output: AsyncIterable<ClaudeSdkOutput>
  readonly nativeSessionId: string | undefined
  offer(input: { promptUuid: string; content: string }, signal?: AbortSignal): Promise<{ state: 'queue-offered'; promptUuid: string }>
  interrupt(): Promise<unknown>
  initializationResult?(): Promise<unknown>
  mcpServerStatus?(): Promise<readonly unknown[]>
  setMcpServers?(servers: Readonly<Record<string, unknown>>): Promise<unknown>
  reconcile(promptUuid: string): readonly ClaudeNativeObservation[]
  close(): Promise<void>
  /** Native query.close terminates work: there is no qualified detach parity. */
  closeForRestart(): Promise<never>
}

export interface ClaudeSdkRunner {
  open(input: ClaudeSdkOpenInput): Promise<ClaudeSdkSession>
  fork(source: ClaudePersistedSession, target: ClaudeSessionScope, signal?: AbortSignal): Promise<ClaudePersistedSession>
  history(session: ClaudePersistedSession, scope: ClaudeSessionScope, signal?: AbortSignal, page?: { offset: number; limit: number }): Promise<readonly unknown[]>
  dispose(): Promise<void>
}
