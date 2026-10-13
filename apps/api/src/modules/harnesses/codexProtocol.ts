import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { HarnessExecutionError } from './errors.js'
import { requireHarnessQualification } from './qualification/gate.js'
import { rememberQualifiedProfile, QUALIFICATION_TARGET_PROFILE } from './qualification/profiles.js'
import { isObject, object, type CodexProtocol, type JsonObject, type RpcRequest } from './codexStdioTransport.js'
import { runCommand } from './process.js'
import { CompatibilityCheckError } from './compatibility/errors.js'
import { checkCodexSchema } from './compatibility/schema.js'
import { passiveDriverPayloads } from './payloadDiscovery.js'
import { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { CodexMethodMap } from './codexMethodTypes.js'

export type CodexClientMethod = keyof CodexMethodMap
/** Typed baseline methods retain the transport's qualified runtime-schema gate. */
export async function codexRequest<M extends CodexClientMethod>(
  transport: { request(method: string, params?: JsonObject, signal?: AbortSignal,
    late?: (value: unknown, error?: Error) => void): Promise<unknown> },
  method: M, params: CodexMethodMap[M]['params'], signal?: AbortSignal,
  late?: (value: CodexMethodMap[M]['result'], error?: Error) => void,
): Promise<CodexMethodMap[M]['result']> {
  const result = await transport.request(method, params, signal,
    late ? (value, error) => late(value as CodexMethodMap[M]['result'], error) : undefined)
  return result as CodexMethodMap[M]['result']
}

const BUNDLE = 'codex_app_server_protocol.schemas.json'

export function canonical(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort)
    if (!isObject(entry)) return entry
    return Object.fromEntries(Object.keys(entry).sort().filter((key) => entry[key] !== undefined).map((key) => [key, sort(entry[key])]))
  }
  return JSON.stringify(sort(value)) ?? 'null'
}

export interface QualifiedCodex {
  binary: string
  identity: string
  protocol: CodexProtocol
  providerVersion: string
  schemaManifestSha256: string
  stableSchemaGitBlob: string
  referenceSchemaManifestSha256: string
}

async function executable(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const paths = isAbsolute(binary) || binary.includes('/') || binary.includes('\\')
    ? [resolve(cwd, binary)]
    : (environment.PATH ?? '').split(delimiter).flatMap((directory) => {
      const base = join(directory || cwd, binary)
      return process.platform === 'win32' && !/\.[a-z]+$/i.test(binary)
        ? (environment.PATHEXT ?? '.EXE;.COM').split(';').map((extension) => base + extension.toLowerCase())
        : [base]
    })
  for (const path of paths) {
    try { await access(path, constants.X_OK); return await realpath(path) } catch { /* ignore: try the next PATH entry. */ }
  }
  throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'The configured Codex executable is unavailable.')
}

const executableFingerprints = new PayloadFingerprintCache()
export async function codexExecutableIdentity(binary: string, options: { fresh?: boolean } = {}): Promise<string> {
  const path = await realpath(binary)
  const value = await stat(path)
  if (!value.isFile()) throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'Codex must be a regular executable file.')
  // pnpm creates hardlinks across worktrees, changing ctime without replacing executable content.
  let fingerprint: string
  if (options.fresh) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    fingerprint = hash.digest('hex')
  } else {
    fingerprint = await executableFingerprints.fingerprint(path)
  }
  const after = await stat(path)
  if (canonical([value.dev, value.ino, value.size, value.mode, value.mtimeMs, value.ctimeMs])
    !== canonical([after.dev, after.ino, after.size, after.mode, after.mtimeMs, after.ctimeMs])
    || await realpath(binary) !== path) {
    throw new HarnessExecutionError('CODEX_EXECUTABLE_CHANGED', 'Codex changed while reading its executable identity.')
  }
  return canonical([path, value.dev, value.ino, value.size, value.mode, value.mtimeMs, fingerprint])
}

export async function codexBinaryIdentity(binary: string, options: { fresh?: boolean } = {}): Promise<string> {
  const payload = await passiveDriverPayloads('codex', binary, process.platform, process.arch,
    options.fresh ? undefined : executableFingerprints)
  const paths = [...new Set([await realpath(binary), ...payload.paths])].sort()
  return canonical(await Promise.all(paths.map(path => codexExecutableIdentity(path, options))))
}

export async function assertCodexUnchanged(qualified: Pick<QualifiedCodex, 'binary' | 'identity'>,
  options: { fresh?: boolean } = { fresh: true }): Promise<void> {
  if (await codexBinaryIdentity(qualified.binary, options) !== qualified.identity) {
    throw new HarnessExecutionError('CODEX_EXECUTABLE_CHANGED', 'Codex changed during qualification; qualify the replacement before launch.')
  }
}

const responseTypes: Record<Exclude<CodexClientMethod, 'config/mcpServer/reload'>, string> = {
  initialize: 'InitializeResponse',
  'thread/start': 'ThreadStartResponse', 'thread/resume': 'ThreadResumeResponse', 'thread/read': 'ThreadReadResponse',
  'thread/turns/list': 'ThreadTurnsListResponse', 'thread/items/list': 'ThreadItemsListResponse',
  'turn/start': 'TurnStartResponse', 'turn/interrupt': 'TurnInterruptResponse',
  'turn/steer': 'TurnSteerResponse', 'thread/fork': 'ThreadForkResponse',
  'config/read': 'ConfigReadResponse', 'model/list': 'ModelListResponse',
  'config/batchWrite': 'ConfigWriteResponse',
  'mcpServerStatus/list': 'ListMcpServerStatusResponse',
  'account/login/start': 'LoginAccountResponse', 'account/login/cancel': 'CancelLoginAccountResponse',
}
const threadResponseFields = {
  thread: 'object', model: 'string', modelProvider: 'string', cwd: 'string', sandbox: 'object',
  approvalPolicy: 'policy', approvalsReviewer: 'string', reasoningEffort: 'string', serviceTier: 'string',
} as const
export const CODEX_RESPONSE_FIELDS: Record<string, Record<string, string>> = {
  InitializeResponse: { userAgent: 'string' },
  ThreadStartResponse: threadResponseFields,
  ThreadResumeResponse: threadResponseFields,
  ThreadForkResponse: threadResponseFields,
  ThreadReadResponse: { thread: 'object' },
  ThreadTurnsListResponse: { data: 'array', nextCursor: 'string' },
  ThreadItemsListResponse: { data: 'array', nextCursor: 'string' },
  ModelListResponse: { data: 'array', nextCursor: 'string' },
  ListMcpServerStatusResponse: { data: 'array', nextCursor: 'string' },
  ConfigReadResponse: { config: 'object' },
  ConfigWriteResponse: { status: 'string', version: 'string' },
  TurnStartResponse: { turn: 'object' },
  TurnSteerResponse: { turnId: 'string' },
  CancelLoginAccountResponse: { status: 'string' },
}

function checkResponseFields(type: string, value: unknown, providerVersion: string): void {
  const fields = CODEX_RESPONSE_FIELDS[type]
  if (!fields) return
  const response = isObject(value) ? value : {}
  for (const [name, expected] of Object.entries(fields)) {
    const observed = response[name]
    if (name === 'nextCursor' && observed === undefined) continue
    if (observed === null && ['reasoningEffort', 'serviceTier', 'nextCursor'].includes(name)) continue
    let valid: boolean
    switch (expected) {
      case 'array':
        valid = Array.isArray(observed)
        break
      case 'object':
        valid = isObject(observed)
        break
      case 'policy':
        valid = typeof observed === 'string' || isObject(observed)
        break
      default:
        valid = typeof observed === expected
    }
    if (!valid) throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED',
      `Codex ${providerVersion} does not satisfy the ${type}.${name} response contract.`)
  }
  if (isObject(response.thread) && (typeof response.thread.id !== 'string' || !Array.isArray(response.thread.turns))) {
    throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED',
      `Codex ${providerVersion} does not satisfy the ${type}.thread identity/history response contract.`)
  }
}

const serverResponseTypes: Record<string, string> = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
}

const compiledSchemas = new Map<string, z.ZodType>()

function referencedDefinitions(schema: JsonObject, definitions: JsonObject): JsonObject {
  const selected: JsonObject = {}
  const pending: unknown[] = [schema]
  const visited = new Set<object>()
  while (pending.length) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    const entry = value as JsonObject
    if (typeof entry.$ref === 'string' && entry.$ref.startsWith('#/definitions/')) {
      const name = entry.$ref.slice('#/definitions/'.length).replace(/~1/g, '/').replace(/~0/g, '~')
      if (!Object.hasOwn(selected, name) && Object.hasOwn(definitions, name)) {
        Object.defineProperty(selected, name, { value: definitions[name], enumerable: true })
        pending.push(definitions[name])
      }
    }
    pending.push(...Object.values(entry))
  }
  return selected
}

/** Validation consumes the installation's generated schemas, not loose object casts. */
export function protocolFromBundle(bundle: JsonObject, providerVersion = 'unknown version'): CodexProtocol {
  const definitions = object(bundle.definitions, 'CODEX_SCHEMA_INVALID')
  const schemaDialect = 'http://json-schema.org/draft-07/schema#' as const
  if (bundle.$schema !== undefined && bundle.$schema !== schemaDialect) {
    throw new HarnessExecutionError('CODEX_SCHEMA_INVALID', 'The qualified schema bundle uses an unsupported JSON Schema dialect.')
  }
  const encodePointerSegment = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')
  const rewriteRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteRefs)
    if (!isObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/definitions/v2/')) {
        return [key, `#/definitions/${encodePointerSegment(`v2/${entry.slice('#/definitions/v2/'.length)}`)}`]
      }
      return [key, rewriteRefs(entry)]
    }))
  }
  const flattenedDefinitions: JsonObject = {}
  for (const [name, schema] of Object.entries(definitions)) {
    if (name === 'v2' && isObject(schema)) {
      for (const [v2Name, v2Schema] of Object.entries(schema)) {
        flattenedDefinitions[`v2/${v2Name}`] = rewriteRefs(v2Schema)
      }
    } else flattenedDefinitions[name] = rewriteRefs(schema)
  }
  const compiled = new Map<string, z.ZodType>()
  const definition = (name: string): JsonObject => {
    const v2 = isObject(definitions.v2) ? definitions.v2 : {}
    const value = v2[name] ?? definitions[name]
    if (!isObject(value)) throw new HarnessExecutionError('CODEX_SCHEMA_MISSING', `Missing schema ${name}.`)
    return value
  }
  const compile = (key: string, schema: JsonObject): z.ZodType => {
    const existing = compiled.get(key)
    if (existing) return existing
    // fromJSONSchema is already provided by the repository's pinned Zod version.
    // Zod resolves a single JSON Pointer segment after `definitions`; Codex's
    // generated bundle nests v2 schemas one level deeper. Flatten that namespace
    // without weakening the generated schema or changing its meaning.
    const rewritten = rewriteRefs(schema) as JsonObject
    // Zod JSON-round-trips each input; unrelated definitions multiply startup work for every RPC validator.
    const document = { ...rewritten, $schema: schemaDialect,
      definitions: referencedDefinitions(rewritten, flattenedDefinitions) }
    const identity = createHash('sha256').update(JSON.stringify(document)).digest('hex')
    let value = compiledSchemas.get(identity)
    if (!value) {
      value = z.fromJSONSchema(document)
      if (compiledSchemas.size >= 256) compiledSchemas.delete(compiledSchemas.keys().next().value!)
      compiledSchemas.set(identity, value)
    }
    compiled.set(key, value)
    return value
  }
  const check = (key: string, schema: JsonObject, value: unknown): void => {
    if (!compile(key, schema).safeParse(value).success) {
      throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED', `Codex ${providerVersion} does not satisfy the ${key} schema contract.`)
    }
  }
  const branch = (name: string, method: string): JsonObject => {
    const schema = definition(name)
    const choices = schema.oneOf ?? schema.anyOf
    if (!Array.isArray(choices)) throw new HarnessExecutionError('CODEX_SCHEMA_INVALID', 'The qualified RPC union is missing.')
    const match = choices.find((choice) => {
      if (!isObject(choice) || !isObject(choice.properties) || !isObject(choice.properties.method)) return false
      const methodSchema = choice.properties.method
      return methodSchema.const === method || (Array.isArray(methodSchema.enum) && methodSchema.enum.includes(method))
    })
    if (!isObject(match)) throw new HarnessExecutionError('CODEX_METHOD_UNQUALIFIED', `Missing ${name} method ${method}.`)
    return match
  }
  // Check required schemas eagerly, before a provider process can execute a turn.
  for (const [method, type] of Object.entries(responseTypes)) {
    compile(`ClientRequest:${method}`, branch('ClientRequest', method))
    compile(type, definition(type))
  }
  for (const [method, type] of Object.entries(serverResponseTypes)) {
    compile(`ServerRequest:${method}`, branch('ServerRequest', method))
    compile(type, definition(type))
  }
  // Older schema fixtures and native releases without dynamic tools keep their
  // existing protocol. A bundle that advertises the response must also carry
  // the matching request branch before file calls can be accepted.
  // Real Codex bundles keep this type at the top level even when a v2 namespace exists.
  const dynamicToolResponse = (isObject(definitions.v2) ? definitions.v2.DynamicToolCallResponse : undefined) ?? definitions.DynamicToolCallResponse
  if (dynamicToolResponse) {
    compile('ServerRequest:item/tool/call', branch('ServerRequest', 'item/tool/call'))
    compile('DynamicToolCallResponse', definition('DynamicToolCallResponse'))
  }
  for (const method of ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved']) {
    compile(`ServerNotification:${method}`, branch('ServerNotification', method))
  }
  return {
    providerVersion,
    request: (message: RpcRequest) => check(`ClientRequest:${message.method}`, branch('ClientRequest', message.method), message),
    serverRequest: (message: RpcRequest) => check(`ServerRequest:${message.method}`, branch('ServerRequest', message.method), message),
    notification: (message: JsonObject) => {
      if (typeof message.method !== 'string') throw new Error('Native method missing.')
      check(`ServerNotification:${message.method}`, branch('ServerNotification', message.method), message)
    },
    response: (method, value) => {
      if (method === 'config/mcpServer/reload' || method === 'thread/compact/start') {
        // This method's response is the native empty object, with no params type.
        if (!isObject(value) || Object.keys(value).length !== 0) throw new Error('Invalid reload response.')
        return
      }
      const type = Object.hasOwn(responseTypes, method) ? responseTypes[method as keyof typeof responseTypes] : undefined
      if (!type) throw new Error('Unqualified response method.')
      check(type, definition(type), value)
      checkResponseFields(type, value, providerVersion)
    },
    serverResponse: (method, value) => {
      const type = method === 'item/tool/call' && dynamicToolResponse ? 'DynamicToolCallResponse' : serverResponseTypes[method]
      if (!type) throw new Error('Unqualified native response.')
      check(type, definition(type), value)
    },
  }
}

async function manifest(directory: string): Promise<string> {
  const entries: string[] = []
  let count = 0
  let total = 0
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const info = await stat(join(directory, name))
        total += info.size
        if (++count > 2_000 || total > 64 * 1024 * 1024) throw new Error('Generated schemas exceeded their size limit.')
        const bytes = await readFile(join(directory, name))
        entries.push(`${name} ${createHash('sha256').update(bytes).digest('hex')}`)
      } else throw new Error('Unexpected generated schema entry.')
    }
  }
  await walk('')
  return createHash('sha256').update(entries.sort().join('\n') + '\n').digest('hex')
}

const verifiedProtocols = new Map<string, QualifiedCodex>()
const executableVersions = new Map<string, string>()

/** Authentication and installation identity are checked even when the protocol is cached. */
export async function qualifyCodex(
  binary: string, cwd: string, environment: NodeJS.ProcessEnv,
  requireAuthentication: boolean, signal?: AbortSignal, recovery?: NativeProcessRecovery,
): Promise<QualifiedCodex> {
  signal?.throwIfAborted()
  const resolved = await executable(binary, cwd, environment)
  const fingerprint = await codexBinaryIdentity(resolved)
  signal?.throwIfAborted()
  const command = (args: string[]) => runCommand(resolved, args, cwd, signal, environment, recovery ? { recovery } : {})
  let actual = executableVersions.get(fingerprint)
  if (!actual) {
    const version = await command(['--version'])
    const output = (version.stdout || version.stderr).trim()
    actual = /^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(output) ? output : 'unknown version'
    if (version.exitCode !== 0) actual = 'unknown version'
    if (actual !== 'unknown version') {
      if (executableVersions.size >= 64) executableVersions.delete(executableVersions.keys().next().value!)
      executableVersions.set(fingerprint, actual)
    }
  }
  const incompatible = (contract: string) => new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED',
    `Codex ${actual || 'unknown version'} does not satisfy ${contract}.`)
  if (actual === 'unknown version') {
    throw incompatible('--version response')
  }
  if (requireAuthentication) {
    const auth = await command(['login', 'status'])
    if (auth.exitCode !== 0 || !`${auth.stdout}\n${auth.stderr}`.includes('Logged in using ChatGPT')) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED',
        `Codex ${actual} requires managed ChatGPT authentication for execution.`)
    }
  }
  const key = canonical([resolved, actual, fingerprint])
  let result = verifiedProtocols.get(key)
  if (!result) {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-codex-schema-'))
    try {
      const generated = await command(['app-server', 'generate-json-schema', '--experimental', '--out', directory])
      if (generated.exitCode !== 0) throw incompatible('app-server generate-json-schema --experimental')
      const bundle = object(JSON.parse(await readFile(join(directory, BUNDLE), 'utf8')), 'CODEX_SCHEMA_INVALID')
      checkCodexSchema(bundle)
      result = {
        binary: resolved, identity: fingerprint, protocol: protocolFromBundle(bundle, actual), providerVersion: actual,
        schemaManifestSha256: await manifest(directory), stableSchemaGitBlob: '', referenceSchemaManifestSha256: '',
      }
      await assertCodexUnchanged(result)
      if (verifiedProtocols.size >= 64) verifiedProtocols.delete(verifiedProtocols.keys().next().value!)
      verifiedProtocols.set(key, result)
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'TimeoutError') throw error
      if (error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_EXECUTABLE_CHANGED') throw error
      if (error instanceof CompatibilityCheckError) {
        throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED', `Codex ${actual}: ${error.message}`)
      }
      const contract = error instanceof HarnessExecutionError ? error.message : 'generated app-server protocol schema'
      throw incompatible(contract)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  await assertCodexUnchanged(result, { fresh: false })
  signal?.throwIfAborted()
  await requireHarnessQualification('codex', actual, resolved)
  rememberQualifiedProfile('codex', actual, QUALIFICATION_TARGET_PROFILE.codex)
  return result
}
