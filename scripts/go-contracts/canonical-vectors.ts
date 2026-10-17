// Execute only in terminal-owned Foreman CI. This produces reference fixtures;
// it does not build either target or run a verification suite.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const reference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const sourceBlob = 'b3c5b4eb3228d12710db8a58811c518a5fdb37eb'
const sourceURL = new URL('../../packages/contracts/src/canonicalJson.ts', import.meta.url)
const sourceBytes = await readFile(sourceURL)
const actualBlob = createHash('sha1')
  .update('blob ' + sourceBytes.length + '\0').update(sourceBytes).digest('hex')
if (actualBlob !== sourceBlob) {
  throw new Error('Canonical TS source differs from frozen reference ' + reference + ': ' + actualBlob)
}
const {
  canonicalJson, canonicalGraphJson,
  canonicalJsonNumericKeysFirstLegacy, canonicalJsonLocaleOrderLegacy,
} = await import(sourceURL.href)

const legacyMode = process.argv[3] === '--legacy'
if (process.argv.length !== (legacyMode ? 4 : 3) || !process.argv[2]) {
  throw new Error('Usage: node --experimental-strip-types scripts/go-contracts/canonical-vectors.ts <output.json> [--legacy]')
}

type Input = {
  kind: string
  number?: string
  units?: number[]
  items?: Input[]
  members?: { key: number[]; value: Input }[]
  length?: number
  depth?: number
}
type Definition = { id: string; input: Input; methods?: string[]; maxBytes?: number; boundary?: string }
type Result = { text?: string; undefined?: boolean; error?: string; sha256?: string }

const units = (text: string) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))
const string = (text: string): Input => ({ kind: 'string', units: units(text) })
const number = (text: string): Input => ({ kind: 'number', number: text })
const nil: Input = { kind: 'null' }
const missing: Input = { kind: 'undefined' }
const array = (...items: Input[]): Input => ({ kind: 'array', items })
const object = (members: [string, Input][]): Input => ({
  kind: 'object', members: members.map(([key, value]) => ({ key: units(key), value })),
})
const truth: Input = { kind: 'true' }
const falsity: Input = { kind: 'false' }

function fromUnits(value: number[] = []): string {
  return value.map(unit => String.fromCharCode(unit)).join('')
}

function materialize(input: Input): unknown {
  switch (input.kind) {
    case 'null': return null
    case 'undefined': return undefined
    case 'true': return true
    case 'false': return false
    case 'number': return Number(input.number)
    case 'string': return fromUnits(input.units)
    case 'array': return (input.items ?? []).map(materialize)
    case 'object': return Object.fromEntries((input.members ?? [])
      .map(member => [fromUnits(member.key), materialize(member.value)]))
    case 'filled-array': return Array(input.length).fill(null)
    case 'nested-array': {
      let value: unknown = null
      for (let depth = 0; depth < (input.depth ?? 0); depth++) value = [value]
      return value
    }
    case 'cycle-array': {
      const value: unknown[] = []
      value.push(value)
      return value
    }
    case 'cycle-object': {
      const value: Record<string, unknown> = {}
      value.self = value
      return value
    }
    case 'date': return new Date('2026-01-01T00:00:00.000Z')
    case 'getter': return Object.defineProperty({}, 'value', {
      enumerable: true, get() { throw new Error('Getter must not be evaluated') },
    })
    case 'symbol': return { [Symbol('non-JSON')]: null }
    case 'array-hole': return new Array(1)
    default: throw new Error('Unknown vector input kind: ' + input.kind)
  }
}

const definitions: Definition[] = [
  {
    id: 'canonical.nested-key-order',
    input: object([['b', object([['d', array(object([['z', number('1')], ['y', number('2')]]))],
      ['c', number('3')]])], ['a', number('1')]]),
  },
  {
    id: 'canonical.integer-like-key-order',
    input: object([['a', number('1')], ['B', number('2')], ['_', number('3')],
      ['10', number('4')], ['9', number('5')]]),
  },
  {
    id: 'canonical.utf16-key-order',
    input: object([['\ufffd', string('replacement')], ['😀', string('pair')],
      ['\ud800', string('unpaired-high')], ['\udc00', string('unpaired-low')],
      ['\ue000', string('private')], ['𐀀', string('supplementary')]]),
  },
  {
    id: 'canonical.missing-null',
    input: object([['a', missing], ['b', nil], ['c', array(missing, nil, number('1'))]]),
  },
  {
    id: 'canonical.number-boundaries',
    input: array(...['-0', '0', '1e-7', '0.000001', '0.0000010000000000000002',
      '1e20', '1e21', '1e23', '1.5e-7', '-1e20', '-1e21',
      '9007199254740991', '9007199254740992', '9007199254740993',
      '1000000000000000100'].map(number)),
  },
  {
    id: 'canonical.number-extremes',
    input: array(...['5e-324', '2.225073858507201e-308', '2.2250738585072014e-308',
      '1.7976931348623157e308', '333333333.33333329', '1.2345678901234568',
      'NaN', 'Infinity', '-Infinity'].map(number)),
  },
  {
    id: 'canonical.unicode-escapes',
    input: object([['text', string('é ☃ 😀 "q"\n\t\r\b\f\u0000<>&\u2028\u2029/\\')]]),
  },
  {
    id: 'canonical.lone-surrogates',
    input: object([['\ud800', string('\udc00')], ['mixed', string('\ud800x\udc00')]]),
  },
  {
    id: 'canonical.persisted-job-digest',
    input: object([['workspaceId', string('w-1')], ['name', string('Fixture')],
      ['items', array(object([['b', number('2')], ['a', number('1')]]), string('é☃'))],
      ['Upper', number('1')], ['lower', number('2')], ['10', string('ten')],
      ['9', string('nine')], ['omitted', missing]]),
    methods: ['canonical'],
  },
  { id: 'canonical.top-level-undefined', input: missing, methods: ['canonical'] },
  { id: 'graph.depth-accepted', input: { kind: 'nested-array', depth: 32 }, methods: ['graph'] },
  { id: 'graph.depth-limit', input: { kind: 'nested-array', depth: 33 }, methods: ['graph'] },
  { id: 'graph.nodes-accepted', input: { kind: 'filled-array', length: 99_999 }, methods: ['graph'] },
  { id: 'graph.nodes-limit', input: { kind: 'filled-array', length: 100_000 }, methods: ['graph'] },
  { id: 'graph.negative-limit', input: nil, maxBytes: -1, methods: ['graph'] },
  { id: 'graph.unsafe-integer-limit', input: nil, maxBytes: 9_007_199_254_740_992, methods: ['graph'] },
  ...['undefined', 'cycle-array', 'cycle-object', 'date'].map(kind => ({
    id: 'graph.reject-' + kind, input: { kind }, methods: ['graph'],
  })),
]

for (const [name, text] of [
  ['empty', ''], ['ascii', 'ascii'], ['accent', 'é'], ['snowman', '☃'],
  ['pair', '😀'], ['high-surrogate', '\ud800'], ['low-surrogate', '\udc00'],
  ['mixed-surrogates', '\ud800x\udc00'], ['escapes', '"\\\n\u0000'],
] as [string, string][]) {
  const input = object([[text, array(string(text), nil, truth, falsity, number('-0'), number('1.5e-7'))]])
  for (const boundary of ['exact', 'above', 'below']) {
    definitions.push({ id: 'graph.bytes-' + name + '-' + boundary, input, boundary, methods: ['graph'] })
  }
}

const legacyDefinitions: Definition[] = [
  {
    id: 'legacy.numeric.array-index-boundaries', methods: ['numericLegacy'],
    input: object(['4294967295', '4294967294', '10', '9', '2', '1', '0',
      '00', '01', '-0', '+1', '1.0', '1e0', ' 1', '', 'a']
      .map((key, index): [string, Input] => [key, number(String(index))])),
  },
  {
    id: 'legacy.numeric.nested-index-order', methods: ['numericLegacy'],
    input: object([['z', array(object([['10', truth], ['9', falsity], ['b', nil], ['a', nil]]))],
      ['10', object([['10', number('10')], ['9', number('9')]])], ['9', string('nine')]]),
  },
  {
    id: 'legacy.numeric.utf16-order', methods: ['numericLegacy'],
    input: object([['\ue000', nil], ['😀', truth], ['\ud800', string('\udc00')],
      ['\udc00', string('\ud800')], ['𐀀', nil], ['B', nil], ['a', nil]]),
  },
  {
    id: 'legacy.numeric.undefined-object-array', methods: ['numericLegacy'],
    input: object([['10', missing], ['9', array(missing, nil, number('1'))], ['value', missing]]),
  },
  { id: 'legacy.numeric.top-undefined', methods: ['numericLegacy'], input: missing },
  {
    id: 'legacy.numeric.nonfinite', methods: ['numericLegacy'],
    input: array(number('NaN'), number('Infinity'), number('-Infinity'), number('-0')),
  },
  {
    id: 'legacy.numeric.number-boundaries', methods: ['numericLegacy'],
    input: array(...['1e-7', '0.000001', '1e20', '1e21', '9007199254740993',
      '1000000000000000100', '5e-324'].map(number)),
  },
  {
    id: 'legacy.numeric.unicode-escapes', methods: ['numericLegacy'],
    input: object([['text', string('é ☃ 😀 "q"\n\t\r\b\f\u0000<>&\u2028\u2029/\\')]]),
  },
  {
    id: 'legacy.numeric.prototype-named-keys', methods: ['numericLegacy'],
    input: object([['__proto__', object([['10', truth], ['9', nil]])], ['constructor', string('value')]]),
  },
  {
    id: 'legacy.locale.case-punctuation', methods: ['localeLegacy'],
    input: object(['a', 'A', 'aa', 'aA', 'Aa', 'AA', '_', '-', '.', ':', ' ', ''].map(key => [key, nil])),
  },
  {
    id: 'legacy.locale.numeric-looking-order', methods: ['localeLegacy'],
    input: object(['10', '9', '2', '02', '-0', '0', '4294967294', '4294967295'].map(key => [key, nil])),
  },
  {
    id: 'legacy.locale.accents', methods: ['localeLegacy'],
    input: object(['é', 'e', 'E', 'É', 'ä', 'a', 'z', 'ö', 'å', 'ß', 'ss', 'İ', 'i', 'ı', 'I'].map(key => [key, nil])),
  },
  {
    id: 'legacy.locale.equivalent-forward', methods: ['localeLegacy'],
    input: object([['é', number('1')], ['e\u0301', number('2')], ['Å', number('3')], ['A\u030a', number('4')]]),
  },
  {
    id: 'legacy.locale.equivalent-reverse', methods: ['localeLegacy'],
    input: object([['e\u0301', number('2')], ['é', number('1')], ['A\u030a', number('4')], ['Å', number('3')]]),
  },
  {
    id: 'legacy.locale.unicode-scripts', methods: ['localeLegacy'],
    input: object(['日本', '中', 'Я', 'я', 'α', 'Ω', 'ع', 'א', 'क', '😀', '☃'].map(key => [key, nil])),
  },
  {
    id: 'legacy.locale.utf16-surrogates', methods: ['localeLegacy'],
    input: object([['\ud800', nil], ['\udc00', truth], ['😀', falsity], ['\ue000', string('private')], ['\ufffd', nil]]),
  },
  {
    id: 'legacy.locale.undefined-object', methods: ['localeLegacy'],
    input: object([['missing', missing], ['null', nil], ['defined', number('1')]]),
  },
  {
    id: 'legacy.locale.undefined-array', methods: ['localeLegacy'],
    input: array(number('1'), missing, nil, missing),
  },
  { id: 'legacy.locale.top-undefined', methods: ['localeLegacy'], input: missing },
  {
    id: 'legacy.locale.nested-key-order', methods: ['localeLegacy'],
    input: object([['payload', object([['B', nil], ['a', array(object([['10', truth], ['9', missing]]))]])],
      ['selection', array(string('é'), number('-0'))]]),
  },
  {
    id: 'legacy.locale.nonfinite', methods: ['localeLegacy'],
    input: array(number('NaN'), number('Infinity'), number('-Infinity'), number('-0')),
  },
]

function capture(action: () => string | undefined): Result {
  try {
    const text = action()
    if (text === undefined) return { undefined: true }
    return { text, sha256: createHash('sha256').update(text).digest('hex') }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { error: error.message }
  }
}

const vectors = (legacyMode ? legacyDefinitions : definitions).map(definition => {
  const value = materialize(definition.input)
  const methods = definition.methods ?? ['canonical', 'graph']
  let maxBytes = definition.maxBytes ?? 8 * 1024 * 1024
  if (definition.boundary) {
    const text = canonicalJson(value)
    if (typeof text !== 'string') throw new Error('Byte vector requires a JSON string result')
    maxBytes = Buffer.byteLength(text) + (definition.boundary === 'above' ? 1 : definition.boundary === 'below' ? -1 : 0)
  }
  return {
    id: definition.id, input: definition.input, maxBytes,
    ...(methods.includes('canonical') ? { canonical: capture(() => canonicalJson(value)) } : {}),
    ...(methods.includes('graph') ? { graph: capture(() => canonicalGraphJson(value, maxBytes)) } : {}),
    ...(methods.includes('numericLegacy') ? { numericLegacy: capture(() => canonicalJsonNumericKeysFirstLegacy(value)) } : {}),
    ...(methods.includes('localeLegacy') ? { localeLegacy: capture(() => canonicalJsonLocaleOrderLegacy(value)) } : {}),
  }
})

const output = resolve(process.argv[2])
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify({
  schemaVersion: 1,
  source: { reference, canonicalBlob: sourceBlob },
  producer: {
    script: fileURLToPath(import.meta.url).split('/').slice(-3).join('/'),
    node: process.version, icu: process.versions.icu,
    cldr: process.versions.cldr, unicode: process.versions.unicode,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    collator: new Intl.Collator().resolvedOptions(),
    environment: { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_COLLATE: process.env.LC_COLLATE },
  },
  ...(legacyMode ? {
    collationProbe: ['a', 'A', 'é', 'e\u0301', '_', '-', '10', '9', '😀', '\ud800', '\udc00']
      .flatMap(left => ['a', 'A', 'é', 'e\u0301', '_', '-', '10', '9', '😀', '\ud800', '\udc00']
        .map(right => ({ left: units(left), right: units(right), sign: Math.sign(left.localeCompare(right)) }))),
  } : {}),
  vectors,
}, null, 2) + '\n')
process.stdout.write(JSON.stringify({ output, vectors: vectors.length, reference, sourceBlob, legacyMode }) + '\n')
