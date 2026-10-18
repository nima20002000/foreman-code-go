// Authoring does not execute this producer. Run only through terminal Foreman
// CI with explicitly selected IDs, the exact frozen checkout and its genuinely
// locked installed SDKs. No listener, database or installation is created.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const frozenReference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const mergedBase = '7fa547058109519a99c904493c916662fde6a474'
const sdkReference = 'cc4b41617ce3601b1290d67216ea0b194a3cd9ac'
const producerPath = 'scripts/go-mcp/capture-ids.mjs'
const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const options = { cases: [] }
for (let index = 0; index < args.length; index++) {
  const key = args[index]
  if (!['--frozen-root', '--candidate', '--tree', '--output', '--case'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error('Use --frozen-root <root> --candidate <sha> --tree <sha> --output <isolated.json> --case <exact-id> (repeat)')
  }
  const value = args[++index]
  if (key === '--case') options.cases.push(value)
  else if (Object.hasOwn(options, key)) throw new Error('Duplicate option ' + key)
  else options[key] = value
}
if (!options['--frozen-root'] || !options['--output'] || !/^[0-9a-f]{40}$/.test(options['--candidate'] ?? '') || !/^[0-9a-f]{40}$/.test(options['--tree'] ?? '') || !options.cases.length || new Set(options.cases).size !== options.cases.length) {
  throw new Error('Full source identities, output and distinct exact --case selections are required')
}
const frozenRoot = resolve(options['--frozen-root'])
const output = resolve(options['--output'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const blob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
function revision(root, expression) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--verify', expression], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Invalid actual Git identity ' + expression)
  return value
}
async function filesAt(root, commit, paths) {
  const files = []
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path))
    const identity = { path, blob: blob(bytes), sha256: sha256(bytes) }
    if (revision(root, commit + ':' + path) !== identity.blob) throw new Error('Dirty or mismatched source at ' + path)
    files.push(identity)
  }
  return files
}

const frozenCommit = revision(frozenRoot, 'HEAD^{commit}')
const frozenTree = revision(frozenRoot, 'HEAD^{tree}')
const candidate = revision(candidateRoot, 'HEAD^{commit}')
const tree = revision(candidateRoot, 'HEAD^{tree}')
if (frozenCommit !== frozenReference || candidate !== options['--candidate'] || tree !== options['--tree']) {
  throw new Error('Actual frozen/candidate checkout identity differs from the required capture identity')
}
execFileSync('git', ['-C', candidateRoot, 'merge-base', '--is-ancestor', mergedBase, candidate], { stdio: 'pipe' })
const frozenFiles = await filesAt(frozenRoot, frozenCommit, [
  'apps/api/src/mcp/unified/transport.ts', 'apps/api/src/mcp/shared/cancellation.ts', 'apps/api/package.json', 'pnpm-lock.yaml',
])
const requiredBlobs = {
  'apps/api/src/mcp/unified/transport.ts': '115b070df04df3fa17fde1b290e5f2a5ceb8ca37',
  'apps/api/src/mcp/shared/cancellation.ts': '40cc2aa29c76ece6d6343ca1dbb779fd016fb4ad',
  'apps/api/package.json': '33f1295414654e648b75bcb7c5f6ff0c87c21179',
}
for (const file of frozenFiles) if (requiredBlobs[file.path] && requiredBlobs[file.path] !== file.blob) throw new Error('Frozen source differs at ' + file.path)
const candidateFiles = await filesAt(candidateRoot, candidate, [producerPath, 'backend/go.mod', 'backend/go.sum'])
const api = JSON.parse(await readFile(resolve(frozenRoot, 'apps/api/package.json'), 'utf8'))
for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/node']) {
  if (api.dependencies?.[name] !== '2.0.0') throw new Error('Frozen application SDK pin differs for ' + name)
}
if (api.dependencies?.zod !== '4.6.3') throw new Error('Frozen application Zod pin differs')

async function runtimeFiles(root, directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await runtimeFiles(root, path))
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) {
      const bytes = await readFile(path)
      result.push({ path: relative(root, path), bytes: bytes.length, sha256: sha256(bytes) })
    }
  }
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

async function packageAt(name, from, version) {
  const resolver = createRequire(from)
  const resolvedEntry = resolver.resolve(name)
  let directory = dirname(resolvedEntry)
  for (;;) {
    try {
      const packageFile = join(directory, 'package.json')
      const bytes = await readFile(packageFile)
      const metadata = JSON.parse(bytes)
      if (metadata.name === name) {
        if (metadata.version !== version) throw new Error('Installed dependency version differs for ' + name)
        const imported = metadata.exports?.['.']?.import
        const target = typeof imported === 'string' ? imported : imported?.default
        if (typeof target !== 'string' || !target.startsWith('./')) throw new Error('Pinned ESM entry is absent for ' + name)
        const moduleFile = resolve(directory, target)
        const entryBytes = await readFile(moduleFile)
        const capture = { name, version, packageFile, packageSHA256: sha256(bytes), resolvedEntry,
          moduleFile, moduleSHA256: sha256(entryBytes), runtimeFiles: await runtimeFiles(directory, join(directory, 'dist')) }
        return { packageFile, moduleFile, capture }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('Cannot locate installed pinned package ' + name)
    directory = parent
  }
}

const apiFile = resolve(frozenRoot, 'apps/api/package.json')
const serverPackage = await packageAt('@modelcontextprotocol/server', apiFile, '2.0.0')
const nodePackage = await packageAt('@modelcontextprotocol/node', apiFile, '2.0.0')
const corePackage = await packageAt('@modelcontextprotocol/core', serverPackage.packageFile, '2.0.0')
const coreRequire = createRequire(corePackage.packageFile)
const zodPackageFile = coreRequire.resolve('zod/package.json')
const zodBytes = await readFile(zodPackageFile)
const zodMetadata = JSON.parse(zodBytes)
if (zodMetadata.version !== '4.6.3') throw new Error('Actual core SDK Zod differs from the frozen lock pin')
const zodRoot = dirname(zodPackageFile)
const zodFiles = await Promise.all(['index.js', 'v4/core/core.js', 'v4/core/checks.js', 'v4/core/schemas.js', 'v4/locales/en.js'].map(async path => ({ path, sha256: sha256(await readFile(join(zodRoot, path))) })))
const { WebStandardStreamableHTTPServerTransport } = await import(pathToFileURL(serverPackage.moduleFile).href)
const { toNodeHandler } = await import(pathToFileURL(nodePackage.moduleFile).href)
if (typeof WebStandardStreamableHTTPServerTransport !== 'function' || typeof toNodeHandler !== 'function') throw new Error('Pinned public SDK transport/Node adapter exports are absent')

const label = 'payload � and literal text "id":"�" must survive'
const request = id => `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"fixture_id","arguments":{}}}`
const cases = new Map()
function add(id, token, extra = {}) { cases.set(id, { id, body: request(token), mode: 'default-sse', status: 200, ...extra }) }
const valid = [
  ['integer', '7'], ['decimal', '7.0'], ['exponent', '7e0'], ['negative_zero', '-0'],
  ['rounded_integer', '7.0000000000000001'], ['underflow_zero', '1e-400'],
  ['maximum_safe', '9007199254740991'], ['minimum_safe', '-9007199254740991'],
  ['lone_high', '"\\ud800"'], ['lone_low', '"\\udc00"'], ['surrogate_pair', '"\\ud83d\\ude00"'],
  ['literal_replacement', '"\\ufffd"'], ['lone_and_literal_replacement', '"\\ud800\\ufffd"'],
  ['string_number', '"7"'], ['empty_string', '""'],
]
for (const [name, token] of valid) add('mcp.ids.sse.' + name, token)
add('mcp.ids.sse.error_lone_high', '"\\ud800"', { errorResponse: true })
add('mcp.ids.sse.notification_then_result', '"\\ud800"', { notification: true, backpressure: true })
for (const [name, token] of [
  ['fraction', '1.5'], ['negative_fraction', '-1.5'], ['above_safe', '9007199254740992'], ['below_safe', '-9007199254740992'],
  ['rounded_unsafe', '9007199254740991.5'], ['large_integer', '9223372036854775807'],
  ['positive_overflow', '1e400'], ['negative_overflow', '-1e400'], ['null', 'null'],
]) add('mcp.ids.admission.' + name, token, { status: 400, errorCode: -32700 })
add('mcp.ids.order.accept_before_id', '1.5', { accept: 'application/json', status: 406, errorCode: -32000 })
add('mcp.ids.order.media_before_id', '1.5', { media: 'text/plain', status: 415, errorCode: -32000 })
add('mcp.ids.order.accept_before_media', '1.5', { accept: 'application/json', media: 'text/plain', status: 406, errorCode: -32000 })
for (const [name, token] of [['lone_high', '"\\ud800"'], ['lone_low', '"\\udc00"'], ['negative_zero', '-0'], ['numeric_lexeme', '7e0']]) {
  add('mcp.ids.json_fixture.' + name, token, { mode: 'explicit-json-fixture' })
}
add('mcp.ids.json_fixture.error_lone_high', '"\\ud800"', { mode: 'explicit-json-fixture', errorResponse: true })
add('mcp.ids.json_fixture.notification_then_result', '"\\ud800"', { mode: 'explicit-json-fixture', notification: true })
for (const [prefix, mode] of [['sse', 'default-sse'], ['json_fixture', 'explicit-json-fixture']]) {
  for (const [name, ids, invalid] of [
    ['batch_typed_ids', ['7', '"7"'], false],
    ['batch_lossy_collision', ['"\\ud800"', '"\\ufffd"', '"\\udc00"'], false],
    ['batch_invalid_numeric', ['7', '1.5'], true],
  ]) {
    const id = 'mcp.ids.' + prefix + '.' + name
    cases.set(id, { id, mode, body: '[' + ids.map(request).join(',') + ']', status: invalid ? 400 : 200, ...(invalid ? { errorCode: -32700 } : {}) })
  }
}
for (const id of options.cases) if (!cases.has(id)) throw new Error('Unknown exact capture case ' + id)

function readback(value) {
  if (value === null) return { kind: 'null' }
  if (typeof value === 'string') return { kind: 'string', units: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)) }
  if (typeof value === 'number') return { kind: 'number', value: Object.is(value, -0) ? '-0' : String(value) }
  if (Array.isArray(value)) return { kind: 'array', items: value.map(readback) }
  if (typeof value === 'object') return { kind: 'object', members: Object.keys(value).map(key => ({ key, value: readback(value[key]) })) }
  return { kind: typeof value, value: String(value) }
}
function errorRecord(error) { return error instanceof Error ? { name: error.name, message: error.message } : { value: readback(error) } }
function responseMessages(body, media) {
  if (!media?.startsWith('text/event-stream')) {
    const value = JSON.parse(body)
    return Array.isArray(value) ? value : [value]
  }
  const messages = []
  for (const event of body.split(/\r\n\r\n|\n\n|\r\r/)) {
    const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (data) messages.push(JSON.parse(data))
  }
  return messages
}

async function capture(definition) {
  const parsedBody = JSON.parse(definition.body)
  const callbacks = [], sendErrors = [], observedErrors = [], chunks = [], failures = [], sends = [], forwarded = []
  let bodyReads = 0, ended = false, status = null, headers = null, pressureUsed = false
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    ...(definition.mode === 'explicit-json-fixture' ? { enableJsonResponse: true } : {}),
  })
  transport.onerror = error => observedErrors.push(errorRecord(error))
  transport.onmessage = message => {
    callbacks.push(readback(message))
    if (typeof message.method !== 'string' || !Object.hasOwn(message, 'id')) return
    sends.push((async () => {
      if (definition.notification) await transport.send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: { text: label, id: '�' } } }, { relatedRequestId: message.id })
      await transport.send(definition.errorResponse
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'isolated fixture response error' } }
        : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: label }], structuredContent: { label, id: '�' } } })
    })().catch(error => sendErrors.push(errorRecord(error))))
  }
  const sink = new EventEmitter()
  sink.destroyed = false
  sink.writeHead = (value, values) => { status = value; headers = { ...values }; return sink }
  sink.write = chunk => {
    chunks.push(Buffer.from(chunk))
    if (definition.backpressure && !pressureUsed) {
      pressureUsed = true
      queueMicrotask(() => sink.emit('drain'))
      return false
    }
    return true
  }
  sink.end = chunk => { if (chunk !== undefined) chunks.push(Buffer.from(chunk)); ended = true; sink.emit('finish'); return sink }
  const nodeRequest = {
    method: 'POST', url: '/mcp', headers: { host: 'isolated-fixture.invalid', 'content-type': definition.media ?? 'application/json',
      accept: definition.accept ?? 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    async *[Symbol.asyncIterator]() { bodyReads++; throw new Error('Already parsed fixture body was drained again') },
  }
  const node = toNodeHandler({ fetch: (request, options) => {
    forwarded.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), parsedBody: readback(options?.parsedBody) })
    return transport.handleRequest(request, options)
  } }, { onerror: error => sendErrors.push(errorRecord(error)) })
  let threw = null
  let timer
  try {
    await transport.start()
    await Promise.race([
      node(nodeRequest, sink, parsedBody),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Isolated MCP ID capture did not complete within 10 seconds')), 10_000) }),
    ])
    await Promise.all(sends)
  } catch (error) { threw = errorRecord(error) }
  finally {
    clearTimeout(timer)
    try { await transport.close() } catch (error) { sendErrors.push(errorRecord(error)) }
  }
  const bytes = Buffer.concat(chunks)
  const body = bytes.toString('utf8')
  let messages = []
  try { if (body) messages = responseMessages(body, headers?.['content-type']) } catch (error) { failures.push({ code: 'response-decode', error: errorRecord(error) }) }
  if (threw || sendErrors.length) failures.push({ code: 'unexpected-throw' })
  if (!ended || status !== definition.status) failures.push({ code: 'status-or-completion', expectedStatus: definition.status })
  if (bodyReads !== 0) failures.push({ code: 'parsed-body-redrained' })
  if (forwarded.length !== 1 || JSON.stringify(forwarded[0].parsedBody) !== JSON.stringify(readback(parsedBody))) failures.push({ code: 'parsed-body-forwarding' })
  if (definition.status === 200) {
    const requests = Array.isArray(parsedBody) ? parsedBody : [parsedBody]
    if (callbacks.length !== requests.length) failures.push({ code: 'callback-count', expected: requests.length })
    const responses = messages.filter(message => !Object.hasOwn(message, 'method') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')))
    const identity = value => JSON.stringify(readback(value))
    const expected = requests.map(request => identity(JSON.parse(JSON.stringify(request.id)))).sort()
    const actual = responses.map(response => identity(response.id)).sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ code: 'typed-lossless-response-id', expected, actual })
    if (responses.some(response => definition.errorResponse ? response.error?.code !== -32601 : response.result?.structuredContent?.label !== label || response.result?.structuredContent?.id !== '�')) failures.push({ code: 'fixture-payload-readback' })
    const expectedMessages = requests.length + (definition.notification && definition.mode === 'default-sse' ? requests.length : 0)
    if (messages.length !== expectedMessages) failures.push({ code: 'response-message-count', expected: expectedMessages })
    const media = headers?.['content-type'] ?? ''
    if (!(definition.mode === 'default-sse' ? media.startsWith('text/event-stream') : media.startsWith('application/json'))) failures.push({ code: 'response-mode' })
    if (observedErrors.length) failures.push({ code: 'unexpected-transport-error' })
    if (definition.backpressure && !pressureUsed) failures.push({ code: 'backpressure-not-reached' })
  } else {
    if (callbacks.length !== 0 || messages.length !== 1 || messages[0]?.id !== null || messages[0]?.error?.code !== definition.errorCode) failures.push({ code: 'source-transport-error-boundary' })
  }
  return { id: definition.id, mode: definition.mode, request: { body: definition.body, parsed: readback(parsedBody), headers: nodeRequest.headers },
    callbacks, forwarded, bodyReads, ended, response: { status, headers, body, bytes: bytes.length, sha256: sha256(bytes),
      chunks: chunks.map(chunk => ({ bytes: chunk.length, sha256: sha256(chunk), base64: chunk.toString('base64') })), messages: messages.map(readback) },
    backpressure: { requested: Boolean(definition.backpressure), reached: pressureUsed }, observedErrors, sendErrors, threw, failures }
}

const outcomes = []
for (const id of options.cases) {
  try { outcomes.push(await capture(cases.get(id))) }
  catch (error) { outcomes.push({ id, mode: cases.get(id).mode, threw: errorRecord(error), failures: [{ code: 'unexpected-capture-throw' }] }) }
}
const failed = outcomes.filter(outcome => outcome.failures.length !== 0).map(outcome => outcome.id)
const bun = globalThis.Bun
const runtime = { executable: process.execPath, argv0: process.argv0, platform: process.platform, arch: process.arch, versions: { ...process.versions },
  bun: bun ? { version: bun.version ?? null, revision: bun.revision ?? null } : null, javascriptCore: process.versions.webkit ?? process.versions.jsc ?? null }
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1, source: { repository: 'nima20002000/foreman-code-go', reference: frozenReference, mergedBase,
    frozen: { commit: frozenCommit, tree: frozenTree, files: frozenFiles }, candidate: { commit: candidate, tree, files: candidateFiles },
    sdk: { repository: 'modelcontextprotocol/typescript-sdk', reference: sdkReference, version: '2.0.0',
      transportBlob: 'c0f48560a2fa430ef6a7b7d0cfa4f7abfc85c913', schemaBlob: '3a7dd5b56dce4d6b55dc2f320d504e97e9f0f88a', nodeAdapterBlob: '02ad932fc93f317092a0a01f16b4493f4023ca09' } },
  installed: { server: serverPackage.capture, node: nodePackage.capture, core: corePackage.capture, zod: { version: zodMetadata.version, packageFile: zodPackageFile, packageSHA256: sha256(zodBytes), files: zodFiles } },
  producer: { path: producerPath, runtime }, coverage: { selected: options.cases, captured: outcomes.map(outcome => outcome.id), failed, unselected: [...cases.keys()].filter(id => !options.cases.includes(id)) },
  boundary: 'actual frozen public SDK transport and Node parsedBody adapter; isolated callbacks, not full application authentication/body/domain qualification',
  modes: { 'default-sse': 'frozen Foreman transport default', 'explicit-json-fixture': 'supported SDK option fixture only; no deployed setting claim' },
  qualification: 'actual capture only; controller must verify genuine Foreman CI ticket and frozen locked dependency resolution independently', outcomes,
}, null, 2) + '\n')
process.stdout.write(JSON.stringify({ output, candidate, tree, selected: options.cases, captured: outcomes.length, failed }) + '\n')
// Retain every selected case outcome, including throws, before a failing exit.
if (failed.length) process.exitCode = 1
