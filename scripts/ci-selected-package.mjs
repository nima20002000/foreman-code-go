import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') throw new Error('Authenticated Foreman CI required')
process.umask(0o077)
const original = await realpath(fileURLToPath(new URL('..', import.meta.url)))
if (process.argv[2] === 'prepare-lint') {
  console.log('[contracts-lint] lint-only setup; zero compile, dependency emit, or tests')
} else {
  await lint()
}

async function lint() {
  const plan = JSON.parse(await readFile(join(original, 'scripts/ci-selected-package-plan.json'), 'utf8'))
  const parent = join(await realpath(homedir()), '.c')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const owned = await mkdtemp(join(parent, 'contracts-lint-'))
  const facts = { source: plan.source, sourceTree: plan.sourceTree,
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: original }).trim(),
    executedGo: null, selections: [], commands: [], testsRequested: 0,
    fullSuiteExecuted: false, conformanceExecuted: false, cleanup: false }
  const raw = []
  let failed = false
  try {
    if (process.getuid?.() === 0) throw new Error('Existing unprivileged CI user required')
    const environment = { PATH: process.env.PATH, CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      HOME: join(owned, 'home'), TMPDIR: join(owned, 'tmp'), XDG_CONFIG_HOME: join(owned, 'config'),
      XDG_CACHE_HOME: join(owned, 'cache'), XDG_STATE_HOME: join(owned, 'state') }
    for (const value of Object.values(environment).filter(value => value.startsWith(owned))) await mkdir(value, { recursive: true, mode: 0o700 })
    facts.sourceFiles = await Promise.all(plan.files.map(async file => {
      const bytes = await readFile(join(original, file.path))
      const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (blob !== file.blob || sha256 !== file.sha256) throw new Error('Actual source differs: ' + file.path)
      return { path: file.path, blob, sha256 }
    }))
    const packageRoot = join(original, 'packages/contracts')
    const require = createRequire(join(packageRoot, 'package.json'))
    const packageFile = require.resolve('eslint/package.json')
    const eslint = JSON.parse(await readFile(packageFile, 'utf8'))
    const binary = typeof eslint.bin === 'string' ? eslint.bin : eslint.bin.eslint
    const args = [resolve(dirname(packageFile), binary), '--format', 'json', '--max-warnings', '0',
      ...plan.lintFiles.map(path => path.slice('packages/contracts/'.length))]
    const startedAt = new Date().toISOString()
    let stdout = ''
    let stderr = ''
    const exitCode = await new Promise((finish, reject) => {
      const child = spawn(process.execPath, args, { cwd: packageRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', text => { stdout += text })
      child.stderr.on('data', text => { stderr += text })
      child.once('error', reject)
      child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0)))
    })
    const command = { name: 'contracts-affected-eslint', program: process.execPath, args, cwd: packageRoot,
      exitCode, stdout, stderr, startedAt, finishedAt: new Date().toISOString() }
    raw.push(command)
    facts.commands.push({ name: command.name, exitCode, startedAt, finishedAt: command.finishedAt })
    facts.eslint = { version: eslint.version, config: 'packages/contracts/eslint.config.mjs' }
    facts.lint = JSON.parse(stdout)
    facts.lintedFiles = facts.lint.map(file => file.filePath.slice(original.length + 1))
    if (exitCode !== 0 || facts.lint.length !== plan.lintFiles.length ||
        facts.lint.some(file => file.errorCount || file.warningCount || file.fatalErrorCount)) failed = true
  } catch (error) {
    failed = true
    facts.failure = error.stack || String(error)
  } finally {
    try {
      const normalized = ciTestResults([], original)
      if (process.env.TEST_RESULTS_OUTPUT) await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(normalized))
      facts.normalizedSummary = normalized.summary
      await rm(owned, { recursive: true, force: true })
      facts.cleanup = true
    } catch (error) {
      failed = true
      facts.cleanupFailure = error.stack || String(error)
    }
    facts.failed = failed
    const bytes = Buffer.from(JSON.stringify({ plan, facts, commands: raw, originalReports: [] }))
    const encoded = gzipSync(bytes).toString('base64')
    const chunks = encoded.match(/.{1,12000}/g) || ['']
    console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: 'selected-package-reports.json',
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), chunks: chunks.length }))
    chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path: 'selected-package-reports.json', index, data })))
    console.log('[selected-package] ' + JSON.stringify({ stage: 'result', ...facts }))
  }
  process.exitCode = failed ? 1 : 0
}
