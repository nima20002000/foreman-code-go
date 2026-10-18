import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { resolveImport } from '../packages/contracts/src/ciImportGraph.mjs'
import { conformanceTargets, repositoryRoot, validateFile } from './ci-affected-scope.mjs'

const code = /\.[cm]?[jt]sx?$/
const contractsPackage = '@foreman-code/contracts'
const isContracts = specifier => specifier === contractsPackage || specifier.startsWith(`${contractsPackage}/`)

// Setup runs before dependency installation, so this lexical scan uses no parser package.
// Strings, comments, regexp bodies and template text are data; template expressions remain code.
function moduleTokens(source) {
  const tokens = []
  let at = 0
  const push = (kind, value) => tokens.push({ kind, value })
  const expressionStart = () => !tokens.length || /^(?:[([{,:;=!?&|+*%<>~-]|=>|return|throw|case|yield|await)$/.test(tokens.at(-1).value)
  function template() {
    at++
    while (at < source.length) {
      if (source[at] === '\\') at += 2
      else if (source[at] === '`') { at++; return }
      else if (source.startsWith('${', at)) { at += 2; push('punct', '('); scan(true); push('punct', ')') }
      else at++
    }
  }
  function scan(expression = false) {
    let braces = 0
    while (at < source.length) {
      const character = source[at]
      if (/\s/.test(character)) { at++; continue }
      if (source.startsWith('//', at)) { while (at < source.length && source[at] !== '\n') at++; continue }
      if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2)
        if (end < 0) throw new Error('Unterminated comment in selected source.')
        at = end + 2; continue
      }
      if (character === '"' || character === "'") {
        const start = ++at
        while (at < source.length && source[at] !== character) at += source[at] === '\\' ? 2 : 1
        if (at >= source.length) throw new Error('Unterminated string in selected source.')
        push('string', source.slice(start, at++)); continue
      }
      if (character === '`') { push('punct', '`'); template(); push('punct', '`'); continue }
      if (character === '/' && expressionStart()) {
        let end = at + 1, bracket = false
        for (; end < source.length && source[end] !== '\n'; end++) {
          if (source[end] === '\\') { end++; continue }
          if (source[end] === '[') bracket = true
          else if (source[end] === ']') bracket = false
          else if (source[end] === '/' && !bracket) break
        }
        if (source[end] === '/') {
          at = end + 1
          while (/[a-z]/i.test(source[at] ?? '') && at < source.length) at++
          push('punct', '/regexp/'); continue
        }
      }
      if (/[A-Za-z_$]/.test(character)) {
        const start = at++
        while (at < source.length && /[\w$]/.test(source[at])) at++
        push('word', source.slice(start, at)); continue
      }
      if (character === '{') braces++
      if (character === '}') {
        if (expression && braces === 0) { at++; return }
        braces--
      }
      if (source.startsWith('=>', at)) { push('punct', '=>'); at += 2 }
      else { push('punct', character); at++ }
    }
  }
  scan()
  return tokens
}

function literalModuleImports(source) {
  const tokens = moduleTokens(source), values = []
  const literal = token => {
    if (token?.kind !== 'string') return
    if (token.value.includes('\\')) throw new Error('An escaped selected module specifier requires explicit dependency support.')
    values.push(token.value)
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], next = tokens[index + 1]
    if (token.kind !== 'word') continue
    const mock = ['mock', 'doMock', 'importActual', 'importMock'].includes(token.value)
      && tokens[index - 1]?.value === '.' && tokens[index - 2]?.value === 'vi'
    if (!mock && (!['import', 'export', 'require'].includes(token.value) || tokens[index - 1]?.value === '.')) continue
    if (token.value === 'import' && next?.value === '.') continue
    let cursor = index + 1
    if (tokens[cursor]?.value === '<') {
      let depth = 1
      while (++cursor < tokens.length && depth) depth += Number(tokens[cursor].value === '<') - Number(tokens[cursor].value === '>')
    }
    if (tokens[cursor]?.value === '(') { literal(tokens[cursor + 1]); continue }
    if (token.value === 'import' && next?.kind === 'string') { literal(next); continue }
    if (token.value === 'require' || mock || token.value === 'export' && !['{', '*', 'type'].includes(next?.value)) continue
    for (; cursor < tokens.length; cursor++) {
      const current = tokens[cursor]
      if (current.value === 'from') { literal(tokens[cursor + 1]); break }
      if (current.kind === 'string' || [';', '`', '=', 'import', 'export', 'const', 'let', 'function'].includes(current.value)) break
    }
  }
  return values
}

/** Only exports reached by the selected roots are emitted for retained checks. */
export function affectedContracts(request, root = repositoryRoot) {
  const manifest = join(root, 'packages/contracts/package.json')
  let exports
  const visited = new Set(), entries = new Set(), edges = new Map()
  const pending = request.files.filter(file => !file.startsWith('backend/'))
  if (request.conformanceScenarios.length) pending.push('conformance/src/main.ts')
  // The TS oracle starts these programs by path; its launcher imports do not expose their export dependencies.
  const tsOracle = conformanceTargets(request).includes('ts')
  if (tsOracle) pending.push('apps/api/src/server.ts', 'apps/api/src/cli/operatorCredentials.ts')
  const paths = { has: file => !file.startsWith('../') && lstatSync(resolve(root, file), { throwIfNoEntry: false })?.isFile() }
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file) || !code.test(file)) continue
    validateFile(file, root)
    visited.add(file)
    if (file.startsWith('packages/contracts/src/') && /\.[cm]?js$/.test(file)) {
      const declaration = file.replace(/\.([cm]?)js$/, '.d.$1ts')
      if (paths.has(declaration)) {
        edges.set(file, [...edges.get(file) ?? [], declaration])
        pending.push(declaration)
      }
    }
    for (const specifier of literalModuleImports(readFileSync(join(root, file), 'utf8'))) {
      if (!specifier.startsWith('.') && !isContracts(specifier)) continue
      if (isContracts(specifier) && !exports) exports = JSON.parse(readFileSync(manifest, 'utf8')).exports
      const target = resolveImport(file, specifier, paths, exports ?? {})
      if (!target) throw new Error(`Cannot resolve selected dependency ${specifier} from ${file}.`)
      if (target.startsWith('apps/worker/') || target.startsWith('apps/api/') && !tsOracle) {
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
    ...plan.sources.filter(file => code.test(file) && !/\.d\.[cm]?ts$/.test(file))
      .map(file => posix.relative('packages/contracts', file))]
}

export function contractsEntryOutputs(plan) {
  return plan.sources.flatMap(file => {
    const relative = file.slice('packages/contracts/src/'.length)
    if (/\.d\.[cm]?ts$/.test(relative)) return [relative]
    if (relative.endsWith('.json')) return [relative]
    const stem = relative.replace(/\.[cm]?[jt]sx?$/, '')
    const module = /\.[cm][jt]s$/.test(relative) ? relative.at(-3) : ''
    return [`${stem}.${module}js`, `${stem}.d.${module}ts`]
  })
}
