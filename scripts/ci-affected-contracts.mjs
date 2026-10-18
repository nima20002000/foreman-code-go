import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { importSpecifiers, resolveImport } from '../packages/contracts/src/ciImportGraph.mjs'
import { repositoryRoot, validateFile } from './ci-affected-scope.mjs'

const code = /\.[cm]?[jt]sx?$/
const contractsPackage = '@foreman-code/contracts'
const isContracts = specifier => specifier === contractsPackage || specifier.startsWith(`${contractsPackage}/`)

/** Only exports reached by the selected roots are emitted for retained checks. */
export function affectedContracts(request, root = repositoryRoot) {
  const manifest = join(root, 'packages/contracts/package.json')
  let exports
  const visited = new Set(), entries = new Set(), edges = new Map()
  const pending = request.files.filter(file => !file.startsWith('backend/'))
  if (request.conformanceScenarios.length) pending.push('conformance/src/main.ts')
  const paths = { has: file => !file.startsWith('../') && lstatSync(resolve(root, file), { throwIfNoEntry: false })?.isFile() }
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file) || !code.test(file)) continue
    validateFile(file, root)
    visited.add(file)
    for (const specifier of importSpecifiers(readFileSync(join(root, file), 'utf8'))) {
      if (!specifier.startsWith('.') && !isContracts(specifier)) continue
      if (isContracts(specifier) && !exports) exports = JSON.parse(readFileSync(manifest, 'utf8')).exports
      const target = resolveImport(file, specifier, paths, exports ?? {})
      if (!target) throw new Error(`Cannot resolve selected dependency ${specifier} from ${file}.`)
      if (target.startsWith('apps/api/') || target.startsWith('apps/worker/')) {
        throw new Error(`Selected retained dependency crosses the frozen TypeScript backend: ${target}`)
      }
      if (isContracts(specifier)) entries.add(target)
      edges.set(file, [...edges.get(file) ?? [], target])
      pending.push(target)
    }
  }
  const closure = new Set(), remaining = [...entries]
  while (remaining.length) {
    const file = remaining.pop()
    if (closure.has(file) || !file.startsWith('packages/contracts/src/')) continue
    closure.add(file)
    remaining.push(...edges.get(file) ?? [])
  }
  return { entries: [...entries].sort(), sources: [...closure].sort() }
}

export function affectedContractsKey(root, plan) {
  const hash = createHash('sha256').update('affected-contracts-v1\0').update(process.version)
    .update(process.platform).update(process.arch).update(JSON.stringify(plan.entries))
  if (!plan.entries.length) return hash.digest('hex')
  for (const file of ['packages/contracts/package.json', 'pnpm-lock.yaml', ...plan.sources]) {
    hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0')
  }
  return hash.digest('hex')
}

export function contractsCompiler(root = repositoryRoot) {
  const directory = join(root, 'packages/contracts/node_modules/typescript')
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (pkg.name !== '@typescript/typescript6' || pkg.version !== '6.0.2' || typeof pkg.bin?.tsc6 !== 'string') {
    throw new Error('Affected TypeScript requires the pinned @typescript/typescript6@6.0.2 tsc6 compiler.')
  }
  const compiler = resolve(directory, pkg.bin.tsc6)
  if (!compiler.startsWith(`${directory}/`)) throw new Error('The pinned compiler entry point is outside its package.')
  return compiler
}

export function contractsEmitCommand(root, plan, output) {
  if (!plan.entries.length) return []
  return [process.execPath, contractsCompiler(root), '--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node', '--allowJs', '--declaration',
    '--sourceMap', '--rootDir', 'src', '--outDir', output,
    ...plan.entries.map(file => posix.relative('packages/contracts', file))]
}

export function contractsEntryOutputs(plan) {
  return plan.sources.flatMap(file => {
    const relative = file.slice('packages/contracts/src/'.length)
    if (/\.d\.[cm]?ts$/.test(relative)) return []
    if (relative.endsWith('.json')) return [relative]
    const stem = relative.replace(/\.[cm]?[jt]sx?$/, '')
    const module = /\.[cm][jt]s$/.test(relative) ? relative.at(-3) : ''
    return [`${stem}.${module}js`, `${stem}.d.${module}ts`]
  })
}
