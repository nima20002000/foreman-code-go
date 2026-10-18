import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

process.umask(0o077)
const root = fileURLToPath(new URL('..', import.meta.url))
const plan = JSON.parse(readFileSync(join(root, 'scripts/ci-selected-package-plan.json')))
const packageRoot = join(root, 'packages/contracts')
const require = createRequire(join(packageRoot, 'package.json'))
const compilerFile = require.resolve('typescript/package.json')
const compiler = JSON.parse(readFileSync(compilerFile))
if (compiler.name !== '@typescript/typescript6' || compiler.version !== '6.0.2' || !compiler.bin.tsc6) {
  throw new Error('Pinned TS6 compiler and bin.tsc6 are required')
}
const config = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.json')))
const options = { ...config.compilerOptions, noEmit: false, declaration: true,
  rootDir: join(packageRoot, 'src'), outDir: join(packageRoot, 'dist') }
const flags = Object.entries(options).flatMap(([key, value]) => ['--' + key,
  Array.isArray(value) ? value.join(',') : String(value)])
const args = [join(dirname(compilerFile), compiler.bin.tsc6), '--ignoreConfig', ...flags,
  ...plan.compileEntryPoints.map(path => join(root, path))]
rmSync(join(packageRoot, 'dist'), { recursive: true, force: true })
const result = spawnSync(process.execPath, args, { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
const outputs = readdirSync(join(packageRoot, 'dist'), { recursive: true }).filter(path => /\.(?:js|mjs|ts|mts)$/.test(path))
const facts = { compiler: { name: compiler.name, version: compiler.version, bin: compiler.bin },
  program: process.execPath, args, entryPoints: plan.compileEntryPoints, exitCode: result.status,
  outputs: outputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(packageRoot, 'dist', path))).digest('hex') })) }
writeFileSync(join(root, 'scripts/ci-capture-contracts-result.json'), JSON.stringify(facts))
console.log('[capture-contracts] ' + JSON.stringify(facts))
if (result.error) throw result.error
process.exitCode = result.status ?? 1
