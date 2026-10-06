import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ZodError } from 'zod'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, nativeOutputToolArguments,
  parseNativeOutputToolCommand } from '@foreman-code/contracts/worker-native-output'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { HarnessExecutionError } from './errors.js'
import { configurationPermissionRules, object, OPENCODE_HISTORY_PAGE_SIZE,
  type JsonObject } from './opencodeProtocol.js'
import { evaluateOpenCodePermission, nativeOpenCodeMcpToolNames,
  type OpenCodePermissionRule } from './openCodePermissionPolicy.js'
import type { NativeOutputCallCapture } from './port.js'

export interface ResidentOpenCodeRead {
  value: unknown
  nextCursor?: string
}
interface CaptureInput {
  session: NativeSessionReference
  rootTurnId: string
  agentName: string
  toolName: string
  args: unknown
  read(path: string): Promise<ResidentOpenCodeRead>
  verifySession(native: JsonObject): void | Promise<void>
  autoApproval(assistantMessageId: string, callId: string): NativeOutputCallCapture['nativeAutoApproval']
  assertCurrent(): void
}
function conflict(): never {
  throw new HarnessExecutionError('OPENCODE_NATIVE_OUTPUT_CALL_UNAVAILABLE',
    'The original running native output call could not be verified.')
}
function normalizedInput(toolName: string, args: unknown): unknown {
  return nativeOutputToolArguments(parseNativeOutputToolCommand(toolName, args))
}
function rules(value: unknown): OpenCodePermissionRule[] {
  const result = configurationPermissionRules(value)
  if (result.some(rule => !rule.permission || !rule.pattern || !['allow', 'ask', 'deny'].includes(rule.effect))) {
    return conflict()
  }
  return result as OpenCodePermissionRule[]
}
function matchingParts(message: JsonObject, input: CaptureInput, expected: unknown): JsonObject[] {
  const info = object(message.info)
  if (info.sessionID !== input.session.nativeSessionId || info.role !== 'assistant'
    || info.parentID !== input.rootTurnId || info.agent !== input.agentName || info.mode !== input.agentName
    || typeof info.id !== 'string' || !Array.isArray(message.parts)) return []
  const nativeTools = nativeOpenCodeMcpToolNames(input.toolName)
  return message.parts.map(object).filter(part => {
    const state = object(part.state)
    if (part.type !== 'tool' || !nativeTools.includes(String(part.tool)) || state.status !== 'running'
      || part.sessionID !== input.session.nativeSessionId || part.messageID !== info.id
      || typeof part.callID !== 'string' || !part.callID) return false
    try {
      return isDeepStrictEqual(normalizedInput(input.toolName, state.input), expected)
    } catch (error) {
      if (error instanceof ZodError) return false
      throw error
    }
  })
}

async function runningCall(input: CaptureInput, expected: unknown) {
  const calls: Array<{ assistantMessageId: string; callId: string; nativeToolName: string }> = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let foundRoot = false
  for (let page = 0; page < 100 && !foundRoot; page++) {
    const suffix = cursor ? `&before=${encodeURIComponent(cursor)}` : ''
    const result = await input.read(`/session/${encodeURIComponent(input.session.nativeSessionId)}/message`
      + `?limit=${OPENCODE_HISTORY_PAGE_SIZE}${suffix}`)
    if (!Array.isArray(result.value)) return conflict()
    for (const raw of [...result.value].reverse()) {
      const message = object(raw)
      const info = object(message.info)
      if (info.sessionID !== input.session.nativeSessionId || typeof info.id !== 'string') return conflict()
      if (info.role === 'user') {
        if (info.id !== input.rootTurnId) return conflict()
        foundRoot = true
        break
      }
      for (const part of matchingParts(message, input, expected)) {
        calls.push({ assistantMessageId: info.id, callId: String(part.callID), nativeToolName: String(part.tool) })
      }
    }
    if (foundRoot) break
    if (!result.nextCursor || seen.has(result.nextCursor)) return conflict()
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  if (!foundRoot || calls.length !== 1) return conflict()
  const call = calls[0]!
  const latest = object((await input.read(`/session/${encodeURIComponent(input.session.nativeSessionId)}/message/`
    + encodeURIComponent(call.assistantMessageId))).value)
  if (object(latest.info).id !== call.assistantMessageId
    || !matchingParts(latest, input, expected).some(part => part.callID === call.callId
      && part.tool === call.nativeToolName)) return conflict()
  return call
}

async function effectivePolicy(input: CaptureInput,
  call: { assistantMessageId: string; callId: string; nativeToolName: string }) {
  const session = object((await input.read(`/session/${encodeURIComponent(input.session.nativeSessionId)}`)).value)
  await input.verifySession(session)
  const agents = (await input.read('/agent')).value
  if (!Array.isArray(agents)) return conflict()
  const matches = agents.filter(agent => object(agent).name === input.agentName)
  if (matches.length !== 1 || object(matches[0]).permission === undefined) return conflict()
  const nativeTool = call.nativeToolName
  const policy = evaluateOpenCodePermission(nativeTool, '*', [
    ...rules(object(matches[0]).permission), ...rules(session.permission),
  ])
  const permissions = (await input.read('/permission')).value
  if (!Array.isArray(permissions)) return conflict()
  const pending = permissions.map(object).filter(request => request.sessionID === input.session.nativeSessionId
    && object(request.tool).messageID === call.assistantMessageId && object(request.tool).callID === call.callId)
  if (pending.length > 1 || pending.some(request => typeof request.id !== 'string'
    || request.permission !== nativeTool || !isDeepStrictEqual(request.patterns, ['*']))) return conflict()
  if (policy !== 'deny' && pending.length) return 'ask' as const
  return policy
}

/** Inspect the original resident native callback; this reader cannot start a server or submit work. */
export async function captureOpenCodeNativeOutput(input: CaptureInput): Promise<NativeOutputCallCapture> {
  input.assertCurrent()
  if (!Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES).some(name => name === input.toolName)) return conflict()
  const expected = normalizedInput(input.toolName, input.args)
  const root = object((await input.read(`/session/${encodeURIComponent(input.session.nativeSessionId)}/message/`
    + encodeURIComponent(input.rootTurnId))).value)
  const rootInfo = object(root.info)
  if (rootInfo.id !== input.rootTurnId || rootInfo.sessionID !== input.session.nativeSessionId
    || rootInfo.role !== 'user' || rootInfo.agent !== input.agentName) return conflict()
  const call = await runningCall(input, expected)
  const policy = await effectivePolicy(input, call)
  const automatic = input.autoApproval(call.assistantMessageId, call.callId)
  const inputDigest = `sha256:${createHash('sha256').update(canonicalGraphJson(expected, 4 * 1024 * 1024)).digest('hex')}`
  input.assertCurrent()
  return { descriptor: { nativeSessionId: input.session.nativeSessionId, rootTurnId: input.rootTurnId,
    assistantMessageId: call.assistantMessageId, callId: call.callId, toolName: input.toolName,
    nativeToolName: call.nativeToolName, inputDigest },
    effectivePolicy: policy, ...(automatic ? { nativeAutoApproval: automatic } : {}), assertCurrent: input.assertCurrent }
}
