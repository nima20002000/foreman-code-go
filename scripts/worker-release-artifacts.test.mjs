import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildWorkerReleaseArtifacts, publishInstalledWorkerArtifacts, publishWorkerArtifactsToGitHub,
  readCommittedWorkerTargets } from './worker-release-artifacts.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }

test('does not publish the target until GitHub assets can be downloaded and verified', async t => {
  const f = await fixture(t)
  const original = await buildWorkerReleaseArtifacts(f)
  let downloads = 0
  const run = async (command, args) => {
    if (command === 'tar') execFileSync(command, args)
    if (command === 'gh' && args[1] === 'download') {
      downloads++
      assert.equal(JSON.parse(await readFile(join(f.directory, 'index.json'))).github, undefined)
      throw new Error('GitHub asset not found')
    }
  }
  const publish = options => publishWorkerArtifactsToGitHub({ ...options, run, sleep: async () => {} })
  await assert.rejects(publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/worker',
    commit: f.commit, run, publish }), /GitHub asset not found/)
  assert.ok(downloads > 0)
  const retained = JSON.parse(await readFile(join(f.directory, 'index.json')))
  assert.equal(retained.github, undefined)
  assert.deepEqual(retained.artifacts, original.artifacts)
  assert.equal(retained.publication.state, 'failed')
  assert.match(retained.publication.lastError, /GitHub asset not found/)
})

test('rejects a GitHub asset with different bytes after a successful upload', async t => {
  const f = await fixture(t)
  await buildWorkerReleaseArtifacts(f)
  let uploaded = false
  const run = async (command, args) => {
    if (command === 'tar') execFileSync(command, args)
    if (command === 'gh' && args[1] === 'upload') uploaded = true
    if (command === 'gh' && args[1] === 'download') {
      if (!uploaded) throw new Error('no assets match the file pattern')
      await writeFile(args[args.indexOf('--output') + 1], 'corrupted archive')
    }
  }
  await assert.rejects(publishWorkerArtifactsToGitHub({ name: 'example/worker', directory: f.directory,
    commit: f.commit, artifacts: JSON.parse(await readFile(join(f.directory, 'index.json'))).artifacts,
    run, sleep: async () => {} }), /checksum mismatch/)
})

test('retries asset upload when an existing empty release is not yet visible', async t => {
  const f = await fixture(t)
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
  await mkdir(f.directory)
  const manifestSha256 = 'a'.repeat(64)
  const calls = []
  const waits = []
  let uploads = 0
  const simulate = assetSimulator()
  const run = async (command, args) => {
    calls.push({ command, args })
    if (command === 'gh' && args[1] === 'upload' && ++uploads === 1) {
      throw new Error('release not found')
    }
    await simulate(command, args)
    return { stdout: '', stderr: '' }
  }
  const result = await publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256 }], run,
    sleep: async milliseconds => { waits.push(milliseconds) } })
  assert.deepEqual(result, { repository: 'example/worker', tag: `worker-${f.commit}` })
  assert.equal(uploads, 2)
  assert.deepEqual(waits, [5000])
  assert.equal(calls.filter(call => call.command === 'tar').length, 1)
  assert.equal(calls.filter(call => call.command === 'gh' && call.args[1] === 'create').length, 0)
  const upload = calls.find(call => call.command === 'gh' && call.args[1] === 'upload')
  assert.equal(upload.args.includes('--clobber'), false)
  await assert.rejects(stat(upload.args[3]), { code: 'ENOENT' })
})

for (const failure of ['view', 'create', 'upload']) {
  test(`recovers a created release after a temporary ${failure} failure`, async t => {
    const f = await fixture(t)
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
    await mkdir(f.directory)
    const calls = []
    const waits = []
    let exists = failure === 'view'
    let failed = false
    const simulate = assetSimulator()
    const run = async (command, args) => {
      if (command !== 'gh') return simulate(command, args)
      const operation = args[1]
      calls.push(operation)
      if (operation === failure && !failed) {
        failed = true
        if (operation === 'create') exists = true
        throw new Error('release not found')
      }
      if (operation === 'view' && !exists) throw new Error('release not found')
      if (operation === 'create') {
        if (exists) throw new Error('release already exists')
        exists = true
        assert.equal(args.some(arg => arg.endsWith('.tar.gz')), false)
      }
      await simulate(command, args)
    }
    const result = await publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
      sleep: async milliseconds => { waits.push(milliseconds) } })
    assert.equal(result.tag, `worker-${f.commit}`)
    assert.deepEqual(waits, [5000])
    assert.deepEqual(calls, failure === 'view' || failure === 'create'
      ? ['view', 'create', 'view', 'download', 'upload', 'download']
      : ['view', 'create', 'download', 'upload', 'view', 'download', 'upload', 'download'])
  })
}

test('stops retrying after one minute of backoff and cleans up staged assets', async t => {
  const f = await fixture(t)
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
  await mkdir(f.directory)
  const error = new Error('release not found')
  const waits = []
  let uploads = 0
  let asset
  const simulate = assetSimulator()
  const run = async (command, args) => {
    if (command === 'gh' && args[1] === 'upload') {
      uploads++
      asset = args[3]
      throw error
    }
    await simulate(command, args)
  }
  await assert.rejects(publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
    sleep: async milliseconds => { waits.push(milliseconds) } }), thrown => thrown === error)
  assert.equal(uploads, 5)
  assert.deepEqual(waits, [5000, 10000, 20000, 25000])
  await assert.rejects(stat(asset), { code: 'ENOENT' })
})

function assetSimulator() {
  const assets = new Map()
  return async (command, args) => {
    if (command === 'tar') await writeFile(args[1], 'archive')
    if (command === 'gh' && args[1] === 'upload') {
      for (const path of args.slice(3, args.indexOf('--repo'))) {
        assets.set(path.slice(path.lastIndexOf('/') + 1), await readFile(path))
      }
    }
    if (command === 'gh' && args[1] === 'download') {
      const output = args[args.indexOf('--output') + 1]
      const pattern = args[args.indexOf('--pattern') + 1]
      if (!assets.has(pattern)) throw new Error('no assets match the file pattern')
      await writeFile(output, assets.get(pattern))
    }
  }
}

async function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const repository = await mkdtemp(join(cache, 'worker-release-artifacts-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  await mkdir(join(repository, 'apps/worker/artifacts'), { recursive: true })
  await mkdir(join(repository, 'apps/api'), { recursive: true })
  await writeFile(join(repository, 'package.json'), JSON.stringify({ version: '0.0.57', packageManager: 'pnpm@11.27.0' }))
  await writeFile(join(repository, 'apps/api/package.json'), JSON.stringify({ version: '0.1.0' }))
  const targets = [target, { ...target, node: 'v22.23.2' },
    { ...target, osRelease: '26.04', libc: 'glibc-2.43' },
    { ...target, osRelease: '26.04', libc: 'glibc-2.43', node: 'v22.23.2' }]
  for (const [index, value] of targets.entries()) {
    await writeFile(join(repository, `apps/worker/artifacts/ubuntu-${index}-target.json`), JSON.stringify(value))
  }
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.invalid', 'commit', '-qm', 'reviewed targets'])
  const commit = git(['rev-parse', 'HEAD']).toString().trim()
  const directory = join(repository, 'worker-artifacts')
  const productManifestPath = join(repository, 'installed-product.json')
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, commit: options.env.FOREMAN_CODE_WORKER_BUILD_COMMIT })
    const selected = JSON.parse(git(['show', `${options.env.FOREMAN_CODE_WORKER_BUILD_COMMIT}:${args[1]}`]))
    const output = args[2]
    await mkdir(join(output, 'src'), { recursive: true, mode: 0o700 })
    const bytes = Buffer.from('export const worker = true\n')
    await writeFile(join(output, 'src/cli.mjs'), bytes)
    const buildCommit = options.env.FOREMAN_CODE_WORKER_BUILD_COMMIT
    const manifest = { format: 1, version: '0.0.57', commit: buildCommit, lockfileSha256: 'b'.repeat(64),
      packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target: selected,
      sourceSnapshot: { commit: buildCommit, files: [] },
      files: [{ path: 'src/cli.mjs', sha256: sha256(bytes), size: bytes.length }] }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { repository, commit, directory, productManifestPath, run, calls }
}

test('two builds differing only by commit publish the same Worker content identity', async t => {
  const f = await fixture(t)
  const first = await buildWorkerReleaseArtifacts(f)
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'metadata only'], { cwd: f.repository })
  const second = await buildWorkerReleaseArtifacts({ ...f, directory: join(f.repository, 'second-artifacts'),
    productManifestPath: join(f.repository, 'second-product.json') })
  for (const [index, artifact] of first.artifacts.entries()) {
    assert.match(artifact.contentSha256, /^[a-f0-9]{64}$/)
    assert.equal(artifact.contentSha256, second.artifacts[index].contentSha256)
    assert.notEqual(artifact.manifestSha256, second.artifacts[index].manifestSha256)
  }
})

test('packages every reviewed target from one committed release in private storage', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'apps/worker/artifacts/ubuntu-0-target.json'), JSON.stringify({ ...target, node: 'bad' }))
  const index = await buildWorkerReleaseArtifacts(f)
  assert.equal(index.version, '0.0.57')
  assert.equal(JSON.parse(await readFile(f.productManifestPath)).version, '0.0.57')
  assert.equal(JSON.parse(await readFile(join(f.repository, 'apps/api/package.json'))).version, '0.1.0')
  assert.equal((await stat(f.productManifestPath)).mode & 0o077, 0)
  assert.equal(index.artifacts.length, 4)
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.every(call => call.commit === f.commit))
  assert.equal((await stat(f.directory)).mode & 0o077, 0)
  assert.equal((await stat(join(f.directory, 'index.json'))).mode & 0o077, 0)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), index)
  for (const artifact of index.artifacts) {
    const bytes = await readFile(join(f.directory, artifact.manifestSha256, 'manifest.json'))
    assert.equal(sha256(bytes), artifact.manifestSha256)
    assert.deepEqual(JSON.parse(bytes).target, artifact.target)
  }
})

test('builds every reviewed target at once and keeps the reviewed order in the index', async t => {
  const f = await fixture(t)
  let active = 0
  let peak = 0
  const run = async (...args) => {
    active++
    peak = Math.max(peak, active)
    // Each target takes ~10 s on a build computer; one after another made deploys wait for all of them.
    await new Promise(resolve => setTimeout(resolve, 50))
    await f.run(...args)
    active--
  }
  const index = await buildWorkerReleaseArtifacts({ ...f, run })
  assert.equal(peak, 4)
  // Builds finish in any order; the index lists targets in their reviewed (path) order.
  const reviewed = readCommittedWorkerTargets(f.repository, f.commit).map(({ target }) => target)
  assert.deepEqual(index.artifacts.map(artifact => artifact.target), reviewed)
})

test('a failed target build waits for the others before removing artifact storage', async t => {
  const f = await fixture(t)
  let finished = 0
  const run = async (...args) => {
    if (args[1][1].includes('ubuntu-0')) throw new Error('Artifact build failed')
    await new Promise(resolve => setTimeout(resolve, 50))
    await f.run(...args)
    finished++
  }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run }), /Artifact build failed/)
  assert.equal(finished, 3)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
})

test('rejects corrupted build output and removes incomplete artifact storage', async t => {
  const f = await fixture(t)
  const run = async (...args) => {
    await f.run(...args)
    await writeFile(join(args[1][2], 'src/cli.mjs'), 'changed after building')
  }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run }), /checksum mismatch/)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
})

test('keeps failed builds from publishing an index', async t => {
  const f = await fixture(t)
  const run = async () => { throw new Error('Artifact build failed') }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run }), /Artifact build failed/)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
})

test('rejects unsupported reviewed targets before building', async t => {
  const f = await fixture(t)
  const path = join(f.repository, 'apps/worker/artifacts/ubuntu-0-target.json')
  await writeFile(path, JSON.stringify({ ...target, arch: 'arm64' }))
  execFileSync('git', ['add', '.'], { cwd: f.repository })
  execFileSync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.invalid',
    'commit', '-qm', 'unsupported target'], { cwd: f.repository })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.repository, encoding: 'utf8' }).trim()
  assert.throws(() => readCommittedWorkerTargets(f.repository, commit), /linux-x64/)
})

test('blocks a toolchain pin change before publishing updates to format-one workers', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'package.json'), JSON.stringify({ version: '0.0.57', packageManager: 'pnpm@11.28.0' }))
  execFileSync('git', ['add', 'package.json'], { cwd: f.repository })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'change toolchain'], { cwd: f.repository })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.repository, encoding: 'utf8' }).trim()
  const run = async (...args) => {
    await f.run(...args)
    const path = join(args[1][2], 'manifest.json')
    const manifest = JSON.parse(await readFile(path))
    await writeFile(path, `${JSON.stringify({ ...manifest, commit }, null, 2)}\n`)
  }
  const publish = async () => { throw new Error('Incompatible release reached publication') }
  await assert.rejects(buildWorkerReleaseArtifacts({ ...f, run, publish }), /bridge release/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(stat(f.productManifestPath), { code: 'ENOENT' })
})

test('an installed release advances its target only after the publisher succeeds', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  assert.equal(index.github, undefined)
  const calls = []
  const publish = async options => { calls.push(options); return { repository: 'example/fixture', tag: `worker-${f.commit}` } }
  const published = await publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'example/fixture')
  assert.deepEqual(calls[0].artifacts, index.artifacts)
  assert.deepEqual(published, { ...index, github: { repository: 'example/fixture', tag: `worker-${f.commit}` },
    publication: { state: 'published', lastError: null } })
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), published)
  assert.equal((await stat(join(f.directory, 'index.json'))).mode & 0o077, 0)
  await publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  assert.equal(calls.length, 1)
})

test('a failed background upload keeps the target unpublished and records its reason', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  const publish = async () => { throw new Error('GitHub unavailable') }
  await assert.rejects(publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish }), /GitHub unavailable/)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), { ...index,
    publication: { state: 'failed', lastError: 'WORKER_RELEASE_ASSET_UNAVAILABLE: GitHub unavailable' } })
})

test('the installed background publisher loads without build-only source modules', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  const scripts = join(f.repository, 'installed/scripts')
  await mkdir(scripts, { recursive: true })
  for (const name of ['worker-release-artifacts.mjs', 'worker-artifact-files.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(scripts, name))
  }
  const installed = await import(pathToFileURL(join(scripts, 'worker-release-artifacts.mjs')).href)
  const github = { repository: 'example/worker', tag: `worker-${f.commit}` }
  const published = await installed.publishInstalledWorkerArtifacts({ directory: f.directory,
    repositoryName: github.repository, commit: f.commit, run: f.run, publish: async () => github })
  assert.deepEqual(published, { ...index, github, publication: { state: 'published', lastError: null } })
})

test('retries a conflicting create after a stale missing release view without uploading twice', async t => {
  const f = await fixture(t)
  await mkdir(f.directory)
  const calls = []
  const waits = []
  let views = 0
  const simulate = assetSimulator()
  const run = async (command, args) => {
    if (command !== 'gh') return simulate(command, args)
    calls.push(args[1])
    if (args[1] === 'view' && views++ === 0) throw new Error('HTTP 404: release not found')
    if (args[1] === 'create') throw new Error('release already exists')
    await simulate(command, args)
  }
  const result = await publishWorkerArtifactsToGitHub({ ...f, name: 'example/worker',
    artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
    sleep: async delay => { waits.push(delay) } })
  assert.equal(result.tag, `worker-${f.commit}`)
  assert.deepEqual(waits, [5000])
  assert.deepEqual(calls, ['view', 'create', 'view', 'download', 'upload', 'download'])
})

test('runs recovery when the service starts the script through the current release symlink', async t => {
  const root = await mkdtemp(join(homedir(), '.cache', 'foreman-tmp', 'worker-publish-symlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await symlink(join(import.meta.dirname, '..'), join(root, 'current'))
  const release = join(root, 'release')
  await mkdir(join(release, 'worker-artifacts'), { recursive: true })
  await writeFile(join(release, 'worker-artifacts', 'index.json'), JSON.stringify({ format: 1, version: '0.0.0',
    github: { repository: 'owner/repo', tag: 'v0.0.0' }, publication: { state: 'published', lastError: null } }))
  const output = execFileSync(process.execPath, [join(root, 'current', 'scripts', 'worker-release-artifacts.mjs'),
    'recover', release], { encoding: 'utf8' })
  assert.match(output, /Worker artifacts published and verified on GitHub/)
})
