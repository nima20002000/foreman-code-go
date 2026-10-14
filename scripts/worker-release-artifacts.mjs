import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { artifactFiles, validateWorkerTarget, workerReleaseVersion, assertWorkerUpdateToolchain } from './worker-artifact-files.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function committedBytes(repository, commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function readCommittedWorkerTargets(repository, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid Worker build commit')
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'apps/worker/artifacts'],
    { cwd: repository, encoding: 'utf8' }).trim().split('\n')
  const targets = names.filter(path => /^apps\/worker\/artifacts\/[a-zA-Z0-9_.-]+-target\.json$/.test(path))
    .sort().map(path => ({ path, target: JSON.parse(committedBytes(repository, commit, path)) }))
  if (targets.length === 0) throw new Error('No reviewed Worker targets in the installed commit')
  const seen = new Set()
  for (const { target } of targets) {
    validateWorkerTarget(target)
    const key = [target.os, target.osRelease, target.arch, target.libc, target.node].join('/')
    if (seen.has(key)) throw new Error('Duplicate reviewed Worker target')
    seen.add(key)
  }
  return targets
}

async function verifyArtifact(directory, target, version, commit) {
  const { validateManifest } = await import('../apps/worker/src/installation.mjs')
  const { workerArtifactContentSha256 } = await import('../packages/contracts/src/workerArtifactContentNode.mjs')
  const bytes = await readFile(join(directory, 'manifest.json'))
  if (bytes.length > 1_048_576 - 4096) throw new Error('Worker manifest is too large for the device channel')
  const manifest = JSON.parse(bytes)
  validateManifest(manifest, { ...target, rootPersistent: true, homePersistent: true, storagePersistent: true },
    { protocolVersion: 1, identityFormat: 1 })
  if (manifest.version !== version || manifest.commit !== commit
    || !bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))) {
    throw new Error('Worker artifact differs from the installed release')
  }
  const files = (await artifactFiles(directory)).filter(file => file.path !== 'manifest.json')
  if (files.length !== manifest.files.length) throw new Error('Worker artifact file list differs from its manifest')
  for (const file of files) {
    const expected = manifest.files.find(entry => entry.path === file.path)
    if (!expected || expected.size !== file.size || expected.sha256 !== file.sha256) {
      throw new Error(`Worker artifact checksum mismatch: ${file.path}`)
    }
  }
  return { manifestSha256: sha256(bytes), contentSha256: workerArtifactContentSha256(manifest) }
}

async function verifyGitHubAssets({ assets, staging, tag, name, run, cwd }) {
  for (const asset of assets) {
    const filename = asset.slice(asset.lastIndexOf('/') + 1)
    const downloaded = join(staging, `downloaded-${filename}`)
    await rm(downloaded, { force: true })
    await run('gh', ['release', 'download', tag, '--repo', name, '--pattern', filename,
      '--output', downloaded], { cwd })
    if (sha256(await readFile(downloaded)) !== sha256(await readFile(asset))) {
      throw new Error(`GitHub Worker asset checksum mismatch: ${filename}`)
    }
  }
}

/** Uploads each artifact as <manifestSha256>.tar.gz to the GitHub release worker-<commit>, so paired Workers download
 * their update from GitHub with their own login instead of through Main. */
export async function publishWorkerArtifactsToGitHub({ repository, name: knownName, directory, commit, artifacts, run,
  sleep: wait = sleep }) {
  const origin = knownName ? '' : execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repository, encoding: 'utf8' }).trim()
  const name = knownName ?? /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(origin)?.[1]
  if (!name) throw new Error('Worker artifacts publish to GitHub: the repository origin is not a GitHub repository.')
  const tag = `worker-${commit}`
  const staging = await mkdtemp(join(directory, '.publish-'))
  try {
    const assets = []
    for (const { manifestSha256 } of artifacts) {
      const asset = join(staging, `${manifestSha256}.tar.gz`)
      await run('tar', ['-czf', asset, '-C', join(directory, manifestSha256), '.'], { cwd: repository ?? directory })
      assets.push(asset)
    }
    const backoff = [5000, 10000, 20000, 25000]
    for (let attempt = 0; ; attempt++) {
      try {
        const exists = await run('gh', ['release', 'view', tag, '--repo', name], { cwd: repository ?? directory })
          .then(() => true, error => {
            if (/HTTP 404|release not found/iu.test(`${error.message ?? ''} ${error.stderr ?? ''}`)) return false
            throw error
          })
        if (!exists) {
          await run('gh', ['release', 'create', tag, '--repo', name, '--prerelease',
            '--title', `Worker ${commit.slice(0, 12)}`,
            '--notes', `Foreman Code Worker artifacts built from ${commit}.`], { cwd: repository ?? directory })
        }
        await run('gh', ['release', 'upload', tag, ...assets, '--repo', name, '--clobber'], { cwd: repository ?? directory })
        await verifyGitHubAssets({ assets, staging, tag, name, run, cwd: repository ?? directory })
        return { repository: name, tag }
      } catch (error) {
        // GitHub can briefly hide a release after creation, including from asset uploads.
        const reason = `${error.message ?? ''} ${error.stderr ?? ''}`
        if (attempt === backoff.length || !/HTTP (?:404|429|5\d\d)|release not found|release already exists|ECONNRESET|ETIMEDOUT|timed out/iu.test(reason)) throw error
        console.warn(JSON.stringify({ operation: 'publish Worker release', attempt: attempt + 1,
          nextRetryMs: backoff[attempt], lastError: 'GITHUB_RELEASE_TEMPORARILY_UNAVAILABLE' }))
        await wait(backoff[attempt])
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function buildWorkerReleaseArtifacts({
  repository, directory, productManifestPath, run, publish, expectedCommit,
}) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new Error('Worker source differs from the captured release commit.')
  }
  const productManifest = committedBytes(repository, commit, 'package.json')
  const product = JSON.parse(productManifest)
  assertWorkerUpdateToolchain(product)
  const version = workerReleaseVersion(product)
  const targets = readCommittedWorkerTargets(repository, commit)
  await mkdir(directory, { mode: 0o700 })
  try {
    // Targets build independently; all of them settle before a failure removes the shared storage.
    const builds = await Promise.allSettled(targets.map(async ({ path, target }) => {
      const staging = await mkdtemp(join(directory, '.build-'))
      // The builder requires a fresh directory that it creates itself.
      await rm(staging, { recursive: true })
      await run(process.execPath, ['scripts/build-worker-artifact.mjs', path, staging], {
        cwd: repository,
        env: { ...process.env, FOREMAN_CODE_WORKER_BUILD_COMMIT: commit },
      })
      const identity = await verifyArtifact(staging, target, version, commit)
      await chmod(staging, 0o700)
      await rename(staging, join(directory, identity.manifestSha256))
      return { target, ...identity }
    }))
    const failed = builds.find(build => build.status === 'rejected')
    if (failed) throw failed.reason
    const artifacts = builds.map(build => build.value)
    const github = publish ? await publish({ repository, directory, commit, artifacts, run }) : undefined
    const index = { format: 1, version, ...(github ? { github } : {}), artifacts,
      publication: { state: github ? 'published' : 'pending', lastError: null } }
    await writeFile(join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(productManifestPath, productManifest, { flag: 'wx', mode: 0o600 })
    return index
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function writeArtifactIndex(directory, index) {
  const temporary = join(directory, '.index.json.publishing')
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, join(directory, 'index.json'))
}

export async function recordWorkerPublicationFailure(directory, error) {
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))
  const reason = error instanceof Error ? error.message : String(error)
  const publication = { state: 'failed', lastError: `WORKER_RELEASE_ASSET_UNAVAILABLE: ${reason}`.slice(0, 2000) }
  await writeArtifactIndex(directory, { ...index, publication })
}

/** The device target advances only when all GitHub release assets pass download verification. */
export async function publishInstalledWorkerArtifacts({ directory, repositoryName, commit, run,
  publish = publishWorkerArtifactsToGitHub }) {
  const path = join(directory, 'index.json')
  const index = JSON.parse(await readFile(path, 'utf8'))
  if (index.github && index.publication?.state === 'published') return index
  try {
    await writeArtifactIndex(directory, { ...index, publication: { state: 'pending', lastError: null } })
    const github = await publish({ name: repositoryName, directory, commit, artifacts: index.artifacts, run })
    const published = { ...index, github, publication: { state: 'published', lastError: null } }
    await writeArtifactIndex(directory, published)
    return published
  } catch (error) {
    await recordWorkerPublicationFailure(directory, error)
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'publish') {
  const [directory, repositoryName, commit] = process.argv.slice(3)
  const run = (command, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'inherit', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk)
      stderr = (stderr + chunk.toString()).slice(-1500)
    })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve()
      : reject(new Error(`${command} failed (${code}): ${stderr.trim()}`)))
  })
  try {
    await publishInstalledWorkerArtifacts({ directory, repositoryName, commit, run })
    console.log(`Worker artifacts published and verified on GitHub for ${commit}.`)
  } catch (error) {
    console.error(`WORKER_RELEASE_ASSET_UNAVAILABLE: Worker publication failed: ${error.message}`)
    process.exitCode = 1
  }
}
