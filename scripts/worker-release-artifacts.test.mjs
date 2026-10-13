import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildWorkerReleaseArtifacts, publishInstalledWorkerArtifacts, publishWorkerArtifactsToGitHub,
  readCommittedWorkerTargets } from './worker-release-artifacts.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }

test('retries asset upload when an existing empty release is not yet visible', async t => {
  const f = await fixture(t)
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/worker.git'], { cwd: f.repository })
  await mkdir(f.directory)
  const manifestSha256 = 'a'.repeat(64)
  const calls = []
  const waits = []
  let uploads = 0
  const run = async (command, args) => {
    calls.push({ command, args })
    if (command === 'tar') await writeFile(args[1], 'archive')
    if (command === 'gh' && args[1] === 'upload' && ++uploads === 1) {
      throw new Error('release not found')
    }
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
  assert.ok(upload.args.includes('--clobber'))
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
    const run = async (command, args) => {
      if (command !== 'gh') return
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
    }
    const result = await publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
      sleep: async milliseconds => { waits.push(milliseconds) } })
    assert.equal(result.tag, `worker-${f.commit}`)
    assert.deepEqual(waits, [5000])
    assert.deepEqual(calls, failure === 'view' || failure === 'create'
      ? ['view', 'create', 'view', 'upload'] : ['view', 'create', 'upload', 'view', 'upload'])
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
  const run = async (command, args) => {
    if (command === 'tar') await writeFile(args[1], 'archive')
    if (command === 'gh' && args[1] === 'upload') {
      uploads++
      asset = args[3]
      throw error
    }
  }
  await assert.rejects(publishWorkerArtifactsToGitHub({ ...f, artifacts: [{ manifestSha256: 'a'.repeat(64) }], run,
    sleep: async milliseconds => { waits.push(milliseconds) } }), thrown => thrown === error)
  assert.equal(uploads, 5)
  assert.deepEqual(waits, [5000, 10000, 20000, 25000])
  await assert.rejects(stat(asset), { code: 'ENOENT' })
})

async function fixture(t) {
  const repository = await mkdtemp(join(tmpdir(), 'worker-release-artifacts-'))
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
    const manifest = { format: 1, version: '0.0.57', commit, lockfileSha256: 'b'.repeat(64),
      packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target: selected,
      files: [{ path: 'src/cli.mjs', sha256: sha256(bytes), size: bytes.length }] }
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return { repository, commit, directory, productManifestPath, run, calls }
}

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
  const order = f.calls.map(call => call.args[1])
  assert.deepEqual(index.artifacts.map(artifact => artifact.target.node + artifact.target.osRelease),
    order.map(path => { const value = JSON.parse(execFileSync('git', ['show', `${f.commit}:${path}`], { cwd: f.repository }))
      return value.node + value.osRelease }))
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

test('an installed release publishes to GitHub after the install and then records the release in its index', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  assert.equal(index.github, undefined)
  const calls = []
  const publish = async options => { calls.push(options); return { repository: 'example/fixture', tag: `worker-${f.commit}` } }
  // Uploading took ~78 s inside every install; Workers download through Main until the index names the release.
  const published = await publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'example/fixture')
  assert.deepEqual(calls[0].artifacts, index.artifacts)
  assert.deepEqual(published, { ...index, github: { repository: 'example/fixture', tag: `worker-${f.commit}` } })
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), published)
  assert.equal((await stat(join(f.directory, 'index.json'))).mode & 0o077, 0)
  await publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish })
  assert.equal(calls.length, 1)
})

test('a failed background upload leaves the installed index for Main downloads', async t => {
  const f = await fixture(t)
  const index = await buildWorkerReleaseArtifacts(f)
  const publish = async () => { throw new Error('GitHub unavailable') }
  await assert.rejects(publishInstalledWorkerArtifacts({ directory: f.directory, repositoryName: 'example/fixture',
    commit: f.commit, run: f.run, publish }), /GitHub unavailable/)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'index.json'))), index)
})
