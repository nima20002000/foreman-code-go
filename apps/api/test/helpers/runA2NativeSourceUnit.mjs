/** Dependency-isolated runner for the SAME native-source test file. It executes
 * real source and the real canonical JSON implementation; it does not load or
 * replace Zod schemas, PostgreSQL, providers or production composition. The only
 * runner substitution is Vitest's `it` -> node:test's `it`. This is not a full
 * repository typecheck, Vitest run, native acceptance or database qualification. */
import process from 'node:process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..'), require = createRequire(import.meta.url)
const ts = require(process.env.A2_TYPESCRIPT_PATH || 'typescript')
const cache = new Map()
function load(path) {
  path = resolve(path)
  if (!path.startsWith(root + sep)) throw new Error(`Source escaped repository: ${path}`)
  if (cache.has(path)) return cache.get(path).exports
  const module = { exports: {} }; cache.set(path, module)
  const source = readFileSync(path, 'utf8')
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: path, reportDiagnostics: true })
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Syntax diagnostic in ${path}`)
  const localRequire = name => {
    if (name === 'vitest') return { it }
    // Capture modules import only canonicalGraphJson from this barrel. Load its
    // actual leaf implementation, avoiding unrelated unavailable Zod schemas.
    if (name === '@foreman-code/contracts/wave25') return load(resolve(root, 'packages/contracts/src/wave25/json.ts'))
    if (name.startsWith('node:')) return require(name)
    if (name.startsWith('.')) return load(resolve(dirname(path), name.replace(/\.js$/, '.ts')))
    throw new Error(`Unsupported external import in isolated runner: ${name}`)
  }
  new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputText)(
    localRequire, module, module.exports, path, dirname(path))
  return module.exports
}
load(resolve(here, '../eng04-a2-native-source.test.ts'))
