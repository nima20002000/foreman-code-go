import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { HarnessExecutionError } from './errors.js'
import { requireHarnessQualification } from './qualification/gate.js'
import { harnessProfile, normalizeHarnessVersion } from './qualification/profiles.js'
import { isObject, object, type CodexProtocol, type JsonObject, type RpcRequest } from './codexStdioTransport.js'
import { runCommand } from './process.js'
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

export const QUALIFIED_CODEX_VERSION = 'codex-cli 0.154.0'
/** Historical review reference only; never presented as an installation measurement. */
export const QUALIFIED_CODEX_SCHEMA_SHA256 = 'b785f87f96c4747e9db6c0492cea2de68e99b48f3462908174a1e8122a620054'
/** Exact upstream rust-v0.154.0 stable bundle, not a locally invented schema. */
export const QUALIFIED_STABLE_SCHEMA_GIT_BLOB = '7de4646ea2657038e164609d9473c76c1be7c843'
/** Each admitted release has an independently measured upstream stable schema. */
const qualifiedSchemas: Record<string, { stableGitBlob: string; referenceManifestSha256: string }> = {
  [QUALIFIED_CODEX_VERSION]: {
    stableGitBlob: QUALIFIED_STABLE_SCHEMA_GIT_BLOB,
    referenceManifestSha256: QUALIFIED_CODEX_SCHEMA_SHA256,
  },
  'codex-cli 0.156.1': {
    stableGitBlob: '772a8a0a9633722c7dee40388e3d5d4e81b97078',
    referenceManifestSha256: 'ba31111b6547fcb05e28987ed7310991e017321eda0f7604333b2f9784130ae0',
  },
}
export function isQualifiedCodexVersion(value: string): boolean { return harnessProfile('codex', value) !== null }
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
    try { await access(path, constants.X_OK); return await realpath(path) } catch { /* Try the next PATH entry. */ }
  }
  throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'The configured Codex executable is unavailable.')
}

async function identity(binary: string): Promise<string> {
  const value = await stat(binary)
  if (!value.isFile()) throw new HarnessExecutionError('CODEX_UNAVAILABLE', 'Codex must be a regular executable file.')
  return canonical([await realpath(binary), value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs])
}

export async function assertCodexUnchanged(qualified: QualifiedCodex): Promise<void> {
  if (await identity(qualified.binary) !== qualified.identity) {
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
const serverResponseTypes: Record<string, string> = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
}

/** Validation consumes the installation's generated schemas, not loose object casts. */
export function protocolFromBundle(bundle: JsonObject): CodexProtocol {
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
    return object(v2[name] ?? definitions[name], 'CODEX_SCHEMA_MISSING')
  }
  const compile = (key: string, schema: JsonObject): z.ZodType => {
    const existing = compiled.get(key)
    if (existing) return existing
    // fromJSONSchema is already provided by the repository's pinned Zod version.
    // Zod resolves a single JSON Pointer segment after `definitions`; Codex's
    // generated bundle nests v2 schemas one level deeper. Flatten that namespace
    // without weakening the generated schema or changing its meaning.
    const value = z.fromJSONSchema({ ...rewriteRefs(schema) as JsonObject, $schema: schemaDialect, definitions: flattenedDefinitions })
    compiled.set(key, value)
    return value
  }
  const check = (key: string, schema: JsonObject, value: unknown): void => {
    if (!compile(key, schema).safeParse(value).success) {
      throw new HarnessExecutionError('CODEX_PROTOCOL_INVALID', `Codex payload does not match the qualified ${key} schema.`)
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
    return object(match, 'CODEX_METHOD_UNQUALIFIED')
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

function gitBlob(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** No lifetime auth/version cache: each newly launched process is requalified. */
export async function qualifyCodex(
  binary: string, expectedVersion: string | undefined, cwd: string, environment: NodeJS.ProcessEnv,
  requireAuthentication: boolean, signal?: AbortSignal, recovery?: NativeProcessRecovery,
): Promise<QualifiedCodex> {
  const resolved = await executable(binary, cwd, environment)
  const fingerprint = await identity(resolved)
  const command = (args: string[]) => runCommand(resolved, args, cwd, signal, environment, recovery ? { recovery } : {})
  const version = await command(['--version'])
  const actual = (version.stdout || version.stderr).trim()
  const schema = qualifiedSchemas[actual]
  if (version.exitCode === 0) await requireHarnessQualification('codex', actual, resolved)
  if (version.exitCode !== 0 || (expectedVersion !== undefined
    && normalizeHarnessVersion('codex', actual) !== normalizeHarnessVersion('codex', expectedVersion))) {
    throw new HarnessExecutionError('CODEX_APP_SERVER_VERSION_UNQUALIFIED', 'The installed Codex version has no qualified protocol profile.')
  }
  if (requireAuthentication) {
    const auth = await command(['login', 'status'])
    if (auth.exitCode !== 0 || !`${auth.stdout}\n${auth.stderr}`.includes('Logged in using ChatGPT')) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Managed ChatGPT authentication is required for execution, not for device-code login.')
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'graphql-codex-schema-'))
  try {
    const stable = join(directory, 'stable')
    const experimental = join(directory, 'experimental')
    const stableResult = await command(['app-server', 'generate-json-schema', '--out', stable])
    if (stableResult.exitCode !== 0) throw new Error('Codex schema generation failed.')
    const stableBytes = await readFile(join(stable, BUNDLE))
    // Codex precomputed exports can differ only in harmless JSON formatting.
    const sorted = JSON.parse(canonical(JSON.parse(stableBytes.toString('utf8')))) as unknown
    const formatted = JSON.stringify(sorted, null, 2)
    const candidates = [stableBytes, Buffer.from(formatted), Buffer.from(formatted + '\n')]
    if (schema && !candidates.some((bytes) => gitBlob(bytes) === schema.stableGitBlob)) {
      throw new HarnessExecutionError('CODEX_SCHEMA_UNQUALIFIED', `The installed stable protocol does not match upstream ${actual}.`)
    }
    const generated = await command(['app-server', 'generate-json-schema', '--experimental', '--out', experimental])
    if (generated.exitCode !== 0) throw new Error('Codex experimental schema generation failed.')
    const measuredManifest = await manifest(experimental)
    const bundle = object(JSON.parse(await readFile(join(experimental, BUNDLE), 'utf8')), 'CODEX_SCHEMA_INVALID')
    const protocol = protocolFromBundle(bundle)
    const result: QualifiedCodex = {
      binary: resolved, identity: fingerprint, protocol, providerVersion: actual,
      schemaManifestSha256: measuredManifest,
      stableSchemaGitBlob: schema?.stableGitBlob ?? '',
      referenceSchemaManifestSha256: schema?.referenceManifestSha256 ?? '',
    }
    await assertCodexUnchanged(result)
    await requireHarnessQualification('codex', actual, resolved)
    return result
  } catch (error) {
    if (error instanceof HarnessExecutionError) throw error
    throw new HarnessExecutionError('CODEX_SCHEMA_UNQUALIFIED', 'Installed generated schemas could not be qualified; execution remains disabled.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
