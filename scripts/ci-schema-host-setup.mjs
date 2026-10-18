import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const gitAuth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
const origin = 'https://github.com/nima20002000/foreman-code-go.git'

export async function prepareSource(context) {
  const { checkout, root, plan, required, normalEnvironment, facts, sha256 } = context
  const actualOrigin = await required('runner-origin', 'git', ['remote', 'get-url', 'origin'], checkout,
    normalEnvironment)
  if (actualOrigin.stdout.trim() !== origin) throw new Error('Runner origin is not the approved private fork')
  const repository = join(root, 'repository')
  await required('private-source-clone', 'git', [...gitAuth, 'clone', '--quiet', '--no-checkout',
    '--single-branch', '--no-tags', '--branch', plan.sourceBranch, origin, repository], checkout, normalEnvironment)
  for (const commit of [plan.source, plan.frozen, plan.mergedBase]) {
    await required('private-source-fetch-' + commit.slice(0, 12), 'git',
      [...gitAuth, 'fetch', '--quiet', '--no-tags', 'origin', commit], repository, normalEnvironment)
  }
  const shallow = await required('private-source-history', 'git', ['rev-parse', '--is-shallow-repository'],
    repository, normalEnvironment)
  if (shallow.stdout.trim() !== 'false') throw new Error('Private clone remains shallow')
  await required('private-source-ancestor', 'git', ['merge-base', '--is-ancestor', plan.mergedBase, plan.source],
    repository, normalEnvironment)
  const source = join(root, 'source')
  await required('private-source-worktree', 'git', ['worktree', 'add', '--quiet', '--detach', source, plan.source],
    repository, normalEnvironment)
  facts.sourceWorktreeCreated = true
  const identity = await required('private-source-identity', 'git', ['rev-parse', 'HEAD', 'HEAD^{tree}',
    plan.frozen + ':packages/contracts/src', plan.source + ':packages/contracts/src'], source, normalEnvironment)
  const [commit, tree, frozenContractsTree, contractsTree] = identity.stdout.trim().split('\n')
  if (commit !== plan.source || tree !== plan.sourceTree) throw new Error('Private source identity differs')
  facts.source = { commit, tree, frozenContractsTree, contractsTree, shallow: false }
  facts.sourceFiles = []
  for (const file of plan.sourceFiles) {
    const bytes = await readFile(join(source, file.path))
    const blob = await required('source-blob-' + file.path, 'git', ['rev-parse', 'HEAD:' + file.path],
      source, normalEnvironment)
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256 || blob.stdout.trim() !== file.blob) {
      throw new Error('Reviewed source differs: ' + file.path)
    }
    facts.sourceFiles.push(file)
  }
  const changed = await required('frozen-contract-diff', 'git', ['diff', '--name-only', plan.frozen, plan.source,
    '--', 'packages/contracts/src', 'packages/contracts/package.json'], source, normalEnvironment)
  const changedPaths = changed.stdout.trim().split('\n').filter(Boolean).sort()
  if (JSON.stringify(changedPaths) !== JSON.stringify([...plan.contractEdits].sort())) {
    throw new Error('Frozen contract changes differ from reviewed paths')
  }
  facts.source.contractEdits = changedPaths
  return source
}

export async function installAndCompile(context, source) {
  const { root, plan, required, environment, facts, sha256 } = context
  const packageRoot = join(source, 'packages/contracts')
  const packageJSON = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const rootJSON = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (rootJSON.packageManager !== plan.packageManager || packageJSON.dependencies.zod !== '4.6.3'
    || packageJSON.devDependencies.typescript !== 'npm:@typescript/typescript6@6.0.2') {
    throw new Error('Pinned package manager or dependencies differ')
  }
  const pnpm = await required('private-pnpm-version', 'corepack', ['pnpm', '--version'], source, environment)
  const pnpmVersion = pnpm.stdout.trim()
  if (pnpmVersion !== rootJSON.packageManager.slice('pnpm@'.length).split('+')[0]) {
    throw new Error('Actual pnpm version differs from the source pin')
  }
  await required('private-locked-install', 'corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts',
    '--filter', '@foreman-code/contracts...', '--store-dir', join(root, 'pnpm-store')], source, environment)
  const require = createRequire(join(packageRoot, 'package.json'))
  const compilerFile = require.resolve('typescript/package.json')
  const compiler = JSON.parse(await readFile(compilerFile, 'utf8'))
  const zod = JSON.parse(await readFile(require.resolve('zod/package.json'), 'utf8'))
  if (compiler.name !== '@typescript/typescript6' || compiler.version !== '6.0.2' || !compiler.bin.tsc6
    || zod.version !== '4.6.3') throw new Error('Installed TS6 or Zod identity differs')
  const config = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'))
  const options = { ...config.compilerOptions, noEmit: false, noCheck: true,
    rootDir: join(packageRoot, 'src'), outDir: join(packageRoot, 'dist') }
  const flags = Object.entries(options).flatMap(([name, value]) =>
    ['--' + name, Array.isArray(value) ? value.join(',') : String(value)])
  await required('private-qualified-emit', process.execPath,
    [join(dirname(compilerFile), compiler.bin.tsc6), '--ignoreConfig', ...flags,
      ...plan.compileRoots.map(path => join(source, path))], packageRoot, environment)
  const outputs = (await readdir(join(packageRoot, 'dist'), { recursive: true }))
    .filter(path => path.endsWith('.js')).sort()
  if (JSON.stringify(outputs) !== JSON.stringify(Object.keys(plan.qualifiedOutputs).sort())) {
    throw new Error('Compiled closure differs from the three qualified modules')
  }
  facts.compiled = []
  for (const path of outputs) {
    const hash = sha256(await readFile(join(packageRoot, 'dist', path)))
    if (hash !== plan.qualifiedOutputs[path]) throw new Error('Qualified emit hash differs: ' + path)
    facts.compiled.push({ path, sha256: hash })
  }
  facts.compiler = { name: compiler.name, version: compiler.version, bin: compiler.bin.tsc6, options,
    reusedStrictTicket: plan.strictQualificationTicket, strictCheckExecuted: false }
  facts.dependencies = { packageManager: rootJSON.packageManager, pnpmVersion, zodVersion: zod.version,
    lockfileSHA256: sha256(await readFile(join(source, 'pnpm-lock.yaml'))), frozenLockfile: true,
    ignoredScripts: true, privateStore: true, unchangedReleaseAgePolicy: true }
}
