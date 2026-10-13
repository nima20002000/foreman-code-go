import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  return sha256(bytes)
}

/** Uploads each artifact as <manifestSha256>.tar.gz to the GitHub release worker-<commit>, so paired Workers download
 * their update from GitHub with their own login instead of through Main. */
export async function publishWorkerArtifactsToGitHub({ repository, directory, commit, artifacts, run, sleep: wait = sleep }) {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repository, encoding: 'utf8' }).trim()
  const name = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(origin)?.[1]
  if (!name) throw new Error('Worker artifacts publish to GitHub: the repository origin is not a GitHub repository.')
  const tag = `worker-${commit}`
  const staging = await mkdtemp(join(directory, '.publish-'))
  try {
    const assets = []
    for (const { manifestSha256 } of artifacts) {
      const asset = join(staging, `${manifestSha256}.tar.gz`)
      await run('tar', ['-czf', asset, '-C', join(directory, manifestSha256), '.'], { cwd: repository })
      assets.push(asset)
    }
    const backoff = [5000, 10000, 20000, 25000]
    for (let attempt = 0; ; attempt++) {
      try {
        const exists = await run('gh', ['release', 'view', tag, '--repo', name], { cwd: repository })
          .then(() => true, () => false)
        if (!exists) {
          await run('gh', ['release', 'create', tag, '--repo', name, '--prerelease',
            '--title', `Worker ${commit.slice(0, 12)}`,
            '--notes', `Foreman Code Worker artifacts built from ${commit}.`], { cwd: repository })
        }
        await run('gh', ['release', 'upload', tag, ...assets, '--repo', name, '--clobber'], { cwd: repository })
        return { repository: name, tag }
      } catch (error) {
        // GitHub can briefly hide a release after creation, including from asset uploads.
        if (attempt === backoff.length) throw error
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
    const artifacts = []
    for (const { path, target } of targets) {
      const staging = await mkdtemp(join(directory, '.build-'))
      // The builder requires a fresh directory that it creates itself.
      await rm(staging, { recursive: true })
      await run(process.execPath, ['scripts/build-worker-artifact.mjs', path, staging], {
        cwd: repository,
        env: { ...process.env, FOREMAN_CODE_WORKER_BUILD_COMMIT: commit },
      })
      const manifestSha256 = await verifyArtifact(staging, target, version, commit)
      await chmod(staging, 0o700)
      await rename(staging, join(directory, manifestSha256))
      artifacts.push({ target, manifestSha256 })
    }
    const github = publish ? await publish({ repository, directory, commit, artifacts, run }) : undefined
    const index = { format: 1, version, ...(github ? { github } : {}), artifacts }
    await writeFile(join(directory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(productManifestPath, productManifest, { flag: 'wx', mode: 0o600 })
    return index
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
