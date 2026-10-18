import { execFileSync } from 'node:child_process'
import { ciCodeFile, ciInfrastructureFile, importSpecifiers, resolveImport } from '../packages/contracts/src/ciImportGraph.mjs'

const retained = file => /^(?:apps\/web|packages\/contracts|conformance|scripts)\//.test(file)
const testFile = file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
const sourceFile = file => /\.[cm]?[jt]sx?$/.test(file)
const documentation = file => /\.md$/.test(file) || /^docs\//.test(file)
const selection = files => ({ scope: 'affected', files: [...new Set(files)].sort(), reason: 'Exact affected source and test closure.' })

function reverseImports(sources, exports) {
  const reverse = new Map(), unresolved = new Map()
  for (const [file, text] of sources) {
    if (!retained(file) || !sourceFile(file)) continue
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@foreman-code/contracts')) continue
      const target = resolveImport(file, specifier, sources, exports)
      if (!target || !retained(target)) {
        unresolved.set(file, specifier)
        continue
      }
      reverse.set(target, [...reverse.get(target) ?? [], file])
    }
    if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(text)) unresolved.set(file, 'computed module dependency')
  }
  return { reverse, unresolved }
}

/** The host calls this public export before deciding whether any selected files need execution. */
export function selectAffectedFiles({ suite, changedFiles, sources, exports = {} }) {
  if (!['unit', 'integration', 'typecheck', 'lint', 'build'].includes(suite)) throw new Error(`Unsupported affected suite: ${suite}`)
  if (!Array.isArray(changedFiles) || !(sources instanceof Map)) throw new Error('Affected selection requires exact changed files and snapshot sources.')
  const changed = [...new Set(changedFiles)].filter(file => !documentation(file))
  if (!changed.length) return selection([])
  if (changed.some(file => !sources.has(file))) throw new Error('Deleted or unavailable changed files require an explicit affected request.')
  const go = changed.filter(file => /^backend\/.*\.go$/.test(file))
  const other = changed.filter(file => !go.includes(file))
  if (go.length && ['unit', 'integration'].includes(suite)) {
    throw new Error('Go test changes require explicit packages and named test roots through a supported native adapter.')
  }
  if (other.some(file => !retained(file) || !ciCodeFile.test(file))) {
    throw new Error('Unsupported changed source requires an explicit bounded affected request.')
  }
  if (suite === 'integration') throw new Error('Integration requires explicit Go test roots or exact conformance scenario IDs.')
  if (suite === 'build' && other.length) throw new Error('Retained bundle builds require explicit release scope.')
  if (suite === 'unit' && other.every(testFile)) return selection(other)
  if (other.some(ciInfrastructureFile)) throw new Error('Shared CI or package infrastructure requires explicit affected consumers.')
  if (suite === 'lint' && other.some(file => !sourceFile(file))) {
    throw new Error('Non-code lint changes require explicit affected consumers.')
  }
  if (suite === 'lint' || suite === 'build') return selection([...go, ...other.filter(sourceFile)])
  const { reverse, unresolved } = reverseImports(sources, exports)
  const affected = new Set(other), pending = [...other]
  while (pending.length) {
    const file = pending.pop()
    for (const importer of reverse.get(file) ?? []) {
      if (!affected.has(importer)) { affected.add(importer); pending.push(importer) }
    }
  }
  for (const file of affected) if (unresolved.has(file)) {
    throw new Error(`Affected dependency scope is unresolved for ${file}: ${unresolved.get(file)}.`)
  }
  const files = [...affected].filter(suite === 'unit' ? testFile : sourceFile)
  if (!files.length && !go.length) throw new Error('Affected changes have no resolved check roots; pass explicit consumers.')
  return selection([...go, ...files])
}

/** Read the immutable snapshot against a supplied ancestor or an existing default-branch merge base. */
export function affectedSnapshot(commit, suite, cwd = process.cwd(), defaultRef = 'origin/main', baseCommit) {
  cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const resolved = git(['rev-parse', '--verify', `${commit}^{commit}`]).trim()
  let base
  if (baseCommit) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error('Invalid explicit affected base SHA.')
    try { git(['merge-base', '--is-ancestor', baseCommit, resolved]); base = baseCommit }
    catch { throw new Error('Affected base is unavailable or is not an ancestor of the resolved commit.') }
  } else {
    if (git(['rev-list', '--parents', '-n', '1', resolved]).trim().split(' ').length > 2) {
      throw new Error('A merge snapshot requires an explicit affected base.')
    }
    try { base = git(['merge-base', resolved, defaultRef]).trim() }
    catch { throw new Error('No affected merge-base is available; supply an explicit ancestor.') }
    if (base === resolved) throw new Error('The default branch head requires an explicit affected base or selected files.')
  }
  const changedFiles = git(['diff', '--name-only', '-z', '--no-renames', base, resolved]).split('\0').filter(Boolean)
  const paths = git(['ls-tree', '-rz', '--name-only', resolved]).split('\0').filter(Boolean)
  const needed = paths.filter(file => retained(file) && ciCodeFile.test(file) || /^backend\/.*\.go$/.test(file))
  const sources = new Map(needed.map(file => [file, git(['show', `${resolved}:${file}`])]))
  const manifest = sources.get('packages/contracts/package.json')
  return selectAffectedFiles({ suite, changedFiles, sources, exports: manifest ? JSON.parse(manifest).exports : {} })
}
