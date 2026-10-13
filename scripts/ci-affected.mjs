import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciCodeFile as codeFile, ciInfrastructureFile, importSpecifiers as imports, resolveImport }
  from '../packages/contracts/src/ciImportGraph.mjs'

const projects = ['apps/api', 'apps/web', 'apps/worker', 'packages/contracts']
const testFile = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
const integrationFile = /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/

/** Reverse import reachability, like Vitest related/changed, with separate package test inventories. */
export function selectAffectedFiles({ suite, changedFiles, sources, exports = {} }) {
  const full = reason => ({ scope: 'full', files: [], reason })
  if (!['unit', 'integration', 'lint', 'typecheck'].includes(suite)) return full('This suite requires a full run.')
  if (changedFiles.some(ciInfrastructureFile)) return full('Shared CI infrastructure changed.')
  if (changedFiles.some(file => codeFile.test(file) && !sources.has(file))) return full('A source file was removed.')
  // Glob dependencies cannot be represented by one literal import edge.
  if ([...sources.values()].some(text => /import\.meta\.glob\s*\(/.test(text))) return full('Glob imports require a full run.')
  const dependents = new Map()
  for (const [file, text] of sources) {
    for (const specifier of imports(text)) {
      const target = resolveImport(file, specifier, sources, exports)
      if (target) dependents.set(target, [...dependents.get(target) ?? [], file])
    }
  }
  const affected = new Set(changedFiles)
  const pending = [...affected]
  for (let index = 0; index < pending.length; index++) {
    for (const file of dependents.get(pending[index]) ?? []) {
      if (!affected.has(file)) { affected.add(file); pending.push(file) }
    }
  }
  let files
  if (suite === 'integration') files = [...affected].filter(file => sources.has(file) && integrationFile.test(file))
  else if (suite === 'unit') {
    files = [...affected].filter(file => sources.has(file) && testFile.test(file)
      && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file))
      && (projects.some(project => file.startsWith(`${project}/`)) || file.startsWith('scripts/')))
  } else if (suite === 'lint') {
    files = changedFiles.filter(file => sources.has(file) && /\.[cm]?[jt]sx?$/.test(file)
      && projects.some(project => file.startsWith(`${project}/`)))
  } else {
    files = [...affected].filter(file => sources.has(file) && /\.tsx?$/.test(file)
      && projects.some(project => file.startsWith(`${project}/`)))
  }
  return { scope: 'affected', files: [...new Set(files)].sort(), reason: 'Selected from changed files and their imports.' }
}

/** Read the snapshot tree against an explicit ancestor or its default branch merge-base. */
export function affectedSnapshot(commit, suite, cwd = process.cwd(), defaultRef = 'origin/main', baseCommit) {
  cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  const git = (args, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
  if (!baseCommit && git(['rev-list', '--parents', '-n', '1', commit]).split(' ').length > 2) {
    return { scope: 'full', files: [], reason: 'Merge commits require a full run.' }
  }
  let base
  if (baseCommit) {
    try {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error('Invalid base SHA.')
      git(['merge-base', '--is-ancestor', baseCommit, commit])
      base = baseCommit
    } catch {
      return { scope: 'full', files: [], reason: 'baseCommit is unavailable or is not an ancestor of the resolved commit.' }
    }
  } else {
    try {
      if (git(['rev-parse', '--verify', defaultRef]) === git(['rev-parse', commit])) {
        return { scope: 'full', files: [], reason: 'The commit is the workspace default branch head.' }
      }
      base = git(['merge-base', commit, defaultRef])
    }
    catch { return { scope: 'full', files: [], reason: 'No merge-base with the default branch is available.' } }
  }
  const changedFiles = git(['diff', '--name-only', '--no-renames', '-z', base, commit]).split('\0').filter(Boolean)
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-selection-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') }
    git(['read-tree', commit], env)
    const tree = join(directory, 'tree')
    git(['checkout-index', '--all', `--prefix=${tree}/`], env)
    const paths = git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean)
    const sources = new Map(paths.map(file => [file, codeFile.test(file) ? readFileSync(join(tree, file), 'utf8') : '']))
    const manifest = sources.get('packages/contracts/package.json')
    const exports = manifest ? JSON.parse(manifest).exports : {}
    return selectAffectedFiles({ suite, changedFiles, sources, exports })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
