import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createSession, profileDirectory, readScript, readSession, saveSession } from './storage.mjs'
import { outputQueue } from './queue.mjs'
import { initialization, result, textFrames } from './frames.mjs'
import { executeTool } from './tools.mjs'
export { createSdkMcpServer, tool } from './tools.mjs'

export function query({ prompt, options = {} }) {
  const directory = profileDirectory(options.env ?? process.env)
  const session = createSession(directory, options.cwd, options.resume)
  const output = outputQueue()
  const lifetime = new AbortController()
  const signal = options.abortController?.signal
    ? AbortSignal.any([lifetime.signal, options.abortController.signal]) : lifetime.signal
  const iterator = prompt[Symbol.asyncIterator]()
  let initialized = false
  let active
  let interrupt
  let permissionMode = options.permissionMode ?? 'default'
  let servers = options.mcpServers ?? {}
  const model = options.model ?? 'claude-sonnet-4-6'
  const emit = frame => {
    if (signal.aborted) return
    if (['user', 'assistant', 'result', 'system'].includes(frame.type)) {
      session.messages.push(frame)
      saveSession(directory, session)
    }
    output.push(frame)
  }
  const stop = () => { lifetime.abort(new Error('Fake Claude query closed.')); interrupt?.(); output.close() }
  signal.addEventListener('abort', () => { interrupt?.(); output.close() }, { once: true })
  const run = async () => {
    while (!signal.aborted) {
      const next = await iterator.next()
      if (next.done || signal.aborted) break
      const message = next.value
      if (!initialized) { emit(initialization(session, options)); initialized = true }
      active = message
      emit({ ...message, session_id: session.sessionId })
      const text = typeof message.message.content === 'string' ? message.message.content : JSON.stringify(message.message.content)
      const script = readScript(text)
      if (text === '/compact') {
        emit({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), session_id: session.sessionId,
          compact_metadata: { trigger: 'manual', pre_tokens: 32 } })
      }
      if (script.waitForInterrupt) {
        await new Promise(resolve => { interrupt = resolve; if (signal.aborted) resolve() })
        interrupt = undefined
        if (!signal.aborted) emit(result(session, message, 'Interrupted.', true))
        active = undefined
        continue
      }
      let allowed = true
      for (const call of script.tools ?? []) {
        allowed = await executeTool({ session, model, signal, options: { ...options, mcpServers: servers },
          transcriptPath: join(directory, `${session.sessionId}.json`), emit }, message, call) && allowed
      }
      if (signal.aborted) break
      const failed = Boolean(script.failure) || !allowed
      const answer = String(script.failure ?? (allowed ? script.answer ?? 'Conformance assistant answer.' : 'Tool request denied.'))
      for (const frame of textFrames(session, message, answer, model)) emit(frame)
      emit(result(session, message, answer, failed))
      active = undefined
    }
    output.close()
  }
  void run().catch(error => { if (!signal.aborted) output.close(error) })
  return {
    [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    close: stop,
    async interrupt() { if (active) interrupt?.() },
    async setPermissionMode(mode) { permissionMode = mode },
    async initializationResult() { return { commands: [{ name: 'compact', description: 'Compact native context.' }],
      models: [{ value: model, displayName: model }], permissionMode } },
    async getContextUsage() { return { rawMaxTokens: 200_000, maxTokens: 200_000, totalTokens: session.messages.length,
      model, isAutoCompactEnabled: options.env?.DISABLE_AUTO_COMPACT !== '1' } },
    async mcpServerStatus() { return Object.entries(servers).map(([name, config]) => ({ name, status: 'connected', config,
      tools: config.type === 'sdk' ? config.tools.map(entry => ({ name: entry.name })) : [] })) },
    async setMcpServers(next) {
      const added = Object.keys(next).filter(name => !(name in servers))
      const removed = Object.keys(servers).filter(name => !(name in next))
      servers = next
      return { added, removed, errors: {} }
    },
  }
}

export async function getSessionInfo(sessionId, { dir }) {
  const session = readSession(profileDirectory(), sessionId)
  return session?.cwd === dir ? { sessionId, cwd: dir, createdAt: session.createdAt } : undefined
}

export async function getSessionMessages(sessionId, { dir, offset = 0, limit = 100 }) {
  const session = readSession(profileDirectory(), sessionId)
  if (!session || session.cwd !== dir) throw new Error('Fake Claude history does not match its original session directory.')
  return session.messages.slice(offset, offset + limit)
}

export async function forkSession(sessionId, { dir }) {
  const directory = profileDirectory()
  const original = readSession(directory, sessionId)
  if (!original || original.cwd !== dir) throw new Error('Fake Claude fork does not match its original session directory.')
  const forked = structuredClone(original)
  forked.sessionId = randomUUID()
  forked.messages = forked.messages.map(message => ({ ...message, session_id: forked.sessionId }))
  saveSession(directory, forked)
  return { sessionId: forked.sessionId }
}

export async function listSubagents(sessionId, options) {
  if (!await getSessionInfo(sessionId, options)) throw new Error('Fake Claude subagent session is unavailable.')
  return []
}

export async function getSubagentMessages(sessionId, agentId, options) {
  if (!await getSessionInfo(sessionId, options)) throw new Error('Fake Claude subagent session is unavailable.')
  throw new Error(`Fake Claude has no scripted subagent ${agentId}.`)
}
