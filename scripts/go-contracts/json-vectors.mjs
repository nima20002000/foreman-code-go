// Run only in terminal Foreman CI with the controller-selected frozen TS runner.
// This captures native JSON.parse outcomes; it invokes no compiler or test suite.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const reference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const mergedBase = '7fa547058109519a99c904493c916662fde6a474'
const packagePath = 'apps/api/package.json'
const packageBlob = '33f1295414654e648b75bcb7c5f6ff0c87c21179'
const script = 'scripts/go-contracts/json-vectors.mjs'
if (process.argv.length !== 4) {
  throw new Error('Usage: <actual-frozen-ts-runner> scripts/go-contracts/json-vectors.mjs <frozen-source-root> <output.json>')
}
const frozenRoot = resolve(process.argv[2])
const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(process.argv[3])

function git(root, expression) {
  const value = execFileSync('git', ['-C', root, 'rev-parse', '--verify', expression], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Invalid Git identity for ' + expression)
  return value
}

async function fileIdentity(root, path) {
  const bytes = await readFile(resolve(root, path))
  return { path, blob: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex') }
}

const frozen = { reference: git(frozenRoot, 'HEAD^{commit}'), tree: git(frozenRoot, 'HEAD^{tree}'),
  package: await fileIdentity(frozenRoot, packagePath) }
if (frozen.reference !== reference || frozen.package.blob !== packageBlob ||
    git(frozenRoot, reference + ':' + packagePath) !== frozen.package.blob) {
  throw new Error('Frozen JSON.parse runner source identity differs from the required baseline')
}
const candidate = { reference: git(candidateRoot, 'HEAD^{commit}'), tree: git(candidateRoot, 'HEAD^{tree}'),
  producer: await fileIdentity(candidateRoot, script) }
if (git(candidateRoot, candidate.reference + ':' + script) !== candidate.producer.blob) {
  throw new Error('JSON capture producer differs from its actual candidate tree')
}

const definitions = [
  { id: 'json.scalar.null', json: 'null' },
  { id: 'json.scalar.booleans', json: '[true,false]' },
  { id: 'json.scalar.whitespace', json: ' \t\r\n0 \t\r\n' },
  { id: 'json.string.empty', json: '""' },
  { id: 'json.string.escapes', json: '"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000"' },
  { id: 'json.string.raw-unicode', json: '"Aé中😀\u2028\u2029\ufeff"' },
  { id: 'json.string.lone-high', json: '"\\ud800"' },
  { id: 'json.string.lone-low', json: '"\\udfff"' },
  { id: 'json.string.pair-spellings', json: '["\\ud83d\\ude00","😀"]' },
  { id: 'json.string.adjacent-unpaired', json: '["\\ud800x\\udc00","\\ud800\\ud800","\\udc00\\udc00"]' },
  { id: 'json.object.empty', json: '{}' },
  { id: 'json.array.empty', json: '[]' },
  { id: 'json.object.duplicate-last-value', json: '{"a":1,"b":2,"a":3}' },
  { id: 'json.object.escaped-duplicate', json: '{"a":1,"\\u0061":2}' },
  { id: 'json.object.utf16-keys', json: '{"\\ud800":1,"\\ufffd":2,"\\udc00":3,"":4}' },
  { id: 'json.object.index-order', json: '{"x":0,"10":1,"9":2,"0":3,"00":4,"4294967295":5,"4294967294":6,"-0":7,"10":8}' },
  { id: 'json.object.prototype-names', json: '{"__proto__":{"polluted":true},"constructor":{"prototype":{}},"toString":1}' },
  { id: 'json.object.duplicate-constructor', json: '{"constructor":{"prototype":{}},"constructor":null}' },
  { id: 'json.number.negative-zero', json: '[-0,-0.0,-0e9999,0]' },
  { id: 'json.number.equivalent-spellings', json: '[1,1.0,1e0,1.00e+0,10e-1]' },
  { id: 'json.number.safe-boundaries', json: '[9007199254740991,9007199254740992,9007199254740993,-9007199254740993]' },
  { id: 'json.number.range-overflow', json: '[1e400,-1e400,1e999999999999999999999999]' },
  { id: 'json.number.underflow', json: '[5e-324,2e-324,1e-400,-1e-400]' },
  { id: 'json.number.rounding-boundaries', json: '[0.1,333333333.33333329,1000000000000000100,1.7976931348623157e308,2.2250738585072014e-308]' },
  { id: 'json.nesting.array-depth-10001', json: '['.repeat(10001) + '0' + ']'.repeat(10001) },
  { id: 'json.nesting.object-depth-10001', json: '{"child":'.repeat(10001) + 'null' + '}'.repeat(10001) },
  { id: 'json.nesting.mixed-containers', json: '{"a":[{},[],{"b":[true,null,"x"]}],"c":false}' },
  { id: 'json.invalid.empty', json: '' },
  { id: 'json.invalid.bom', json: '\ufeff0' },
  { id: 'json.invalid.nel', json: '\u00850' },
  { id: 'json.invalid.trailing-value', json: 'true false' },
  { id: 'json.invalid.trailing-comma-array', json: '[1,]' },
  { id: 'json.invalid.trailing-comma-object', json: '{"a":1,}' },
  { id: 'json.invalid.missing-comma', json: '[1 2]' },
  { id: 'json.invalid.missing-colon', json: '{"a" 1}' },
  { id: 'json.invalid.unquoted-key', json: '{a:1}' },
  { id: 'json.invalid.array-hole', json: '[,1]' },
  { id: 'json.invalid.close-mismatch', json: '[1}' },
  { id: 'json.invalid.unclosed-depth-10001', json: '['.repeat(10001) + '0' + ']'.repeat(10000) },
  { id: 'json.invalid.string-control', json: '"a\nb"' },
  { id: 'json.invalid.string-escape', json: '"\\x20"' },
  { id: 'json.invalid.string-unicode-short', json: '"\\u123"' },
  { id: 'json.invalid.string-unicode-hex', json: '"\\uXXXX"' },
  { id: 'json.invalid.string-unterminated', json: '"text' },
  { id: 'json.invalid.number-leading-zero', json: '01' },
  { id: 'json.invalid.number-plus', json: '+1' },
  { id: 'json.invalid.number-no-integer', json: '.1' },
  { id: 'json.invalid.number-no-fraction', json: '1.' },
  { id: 'json.invalid.number-no-exponent', json: '1e+' },
  { id: 'json.invalid.number-hex', json: '0x10' },
  { id: 'json.invalid.number-nan', json: 'NaN' },
  { id: 'json.invalid.number-infinity', json: 'Infinity' },
  { id: 'json.invalid.keyword-case', json: 'TRUE' },
  { id: 'json.invalid.comment', json: '/* comment */0' },
]

const units = value => Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))
function numberBits(value) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, false)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// A flat event stream avoids depending on recursive JSON.stringify/readback
// stack limits when observing the deliberately deep native JSON.parse cases.
function readback(value) {
  const events = []
  const pending = [{ value }]
  while (pending.length) {
    const task = pending.pop()
    if (task.event) { events.push(task.event); continue }
    const current = task.value
    if (current === null) { events.push({ kind: 'null' }); continue }
    if (typeof current === 'string') {
      events.push({ kind: 'string', units: units(current), codePoints: [...current].length })
      continue
    }
    if (typeof current === 'number') { events.push({ kind: 'number', bits: numberBits(current) }); continue }
    if (typeof current === 'boolean') { events.push({ kind: 'boolean', value: current }); continue }
    if (Array.isArray(current)) {
      events.push({ kind: 'array', length: current.length })
      pending.push({ event: { kind: 'end-array' } })
      for (let index = current.length-1; index >= 0; index--) pending.push({ value: current[index] })
      continue
    }
    const keys = Object.keys(current)
    events.push({ kind: 'object', length: keys.length })
    pending.push({ event: { kind: 'end-object' } })
    for (let index = keys.length-1; index >= 0; index--) {
      pending.push({ value: current[keys[index]] })
      pending.push({ event: { kind: 'key', units: units(keys[index]) } })
    }
  }
  return events
}

const vectors = definitions.map(definition => {
  try {
    return { ...definition, accepted: true, events: readback(JSON.parse(definition.json)) }
  } catch (error) {
    return { ...definition, accepted: false, error: { name: error?.name ?? 'unknown', message: String(error?.message ?? error) } }
  }
})
const unexpected = vectors.filter(vector => vector.error && vector.error.name !== 'SyntaxError').map(vector => vector.id)
const bun = globalThis.Bun
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  source: { reference, mergedBase, frozen, candidate, interface: 'JSON.parse without a reviver; Object.keys; JavaScript Number and string iteration' },
  producer: { script, runtime: {
    name: bun ? 'bun' : process.release?.name ?? 'unknown', version: bun?.version ?? process.version,
    executable: process.execPath, execArgv: process.execArgv, versions: { ...process.versions },
    bun: bun ? { version: bun.version ?? null, revision: bun.revision ?? null } : null,
    javascriptCore: process.versions.webkit ?? process.versions.jsc ?? null,
  } },
  vectors, unexpected,
}, null, 2) + '\n')
process.stdout.write(JSON.stringify({ output, reference, candidate: candidate.reference, tree: candidate.tree, vectors: vectors.length, unexpected }) + '\n')
if (unexpected.length) process.exitCode = 1
