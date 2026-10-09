import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { buildCiRuntimeContext, ciRuntimeInputDigest, parseCiLock } from '../../../../worker/artifacts/ci-runtime/context.mjs'
import { expectedPortions } from '../../../../../scripts/verification-runner.mjs'
import type { PreparedCiRuntime } from '@foreman-code/contracts'
import { pruneCiRuntimeCache, readCiRuntimeCache, writeCiRuntimeCache } from './ciRuntimeCache.js'

const run = promisify(execFile)
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u

/** Prepares this build computer for one commit's dependencies, with no human step:
 * a checkout of the commit, an offline package seed fetched with network, the verification
 * image built without network, and the qualification source tree. Returns the facts Main
 * needs to capture and qualify the new runtime. Everything stays inside `installer`. */
export interface CiRuntimeReview { reviewedByPrincipalId: string; decisionDigest: string }
export async function prepareCiRuntime({ repository, commit, installer, review, keepImages = [], keepPaths = [], environment = process.env, log = () => {} }: {
  repository: string; commit: string; installer: string; review: CiRuntimeReview
  /** Image ids referenced by protected configurations and retained execution records. */
  keepImages?: readonly string[]
  /** Installer paths the current protected runtime still uses (its qualification source). */
  keepPaths?: readonly string[]
  environment?: NodeJS.ProcessEnv; log?: (stage: string) => void
}): Promise<PreparedCiRuntime> {
  if (!COMMIT.test(commit)) throw new Error('A full commit id is required.')
  if (!review?.reviewedByPrincipalId || !/^[a-f0-9]{64}$/u.test(review.decisionDigest ?? '')) throw new Error('Owner decision is required.')
  const short = commit.slice(0, 12)
  const env = { ...environment, GIT_TERMINAL_PROMPT: '0' }
  const sh = async (file: string, args: string[], options: { cwd?: string } = {}) => {
    const result = await run(file, args, { env, maxBuffer: 64 * 1024 * 1024, ...options })
    return result.stdout
  }
  if ((await run('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`], { env }).then(() => true, () => false)) === false) {
    await sh('git', ['-C', repository, 'fetch', '--no-tags', 'origin', commit])
  }
  log('reclaim-interrupted-preparation')
  await reclaimInterruptedPreparation({ repository, installer, keepPaths, env })
  log('checking-runtime-cache')
  const inputDigest = await ciRuntimeInputDigest({ repository, commit })
  const imageExists = async (imageId: string) => {
    try {
      await podman(['image', 'exists', imageId], env)
      return true
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false
      throw error
    }
  }
  const cached = await readCiRuntimeCache({ installer, inputDigest, imageExists })
  if (cached) {
    log('reusing-runtime-image')
    const qualificationSource = await extractQualificationSource(repository, commit,
      join(installer, `qualification-source-${short}`), env)
    return { ...cached, commit, qualificationSource, reusedImage: true }
  }
  const source = join(installer, `source-${short}`)
  if (!await exists(source)) {
    log('checkout')
    await sh('git', ['-C', repository, 'worktree', 'add', '--detach', source, commit])
  }
  const head = (await sh('git', ['-C', source, 'rev-parse', 'HEAD'])).trim()
  if (head !== commit) throw new Error('The prepared checkout is not at the requested commit.')

  log('prune-images')
  // Other preparations and recovery records may still own older installer files.
  await pruneCiImages(keepImages, env)
  await pruneCiRuntimeCache({ installer, imageExists })
  // 1. The build stage fetches the frozen lockfile's packages with network into its own store.
  const buildContext = join(installer, `build-context-${short}`)
  await rm(buildContext, { recursive: true, force: true })
  await buildCiRuntimeContext({ repository: source, commit, output: buildContext })
  const buildTag = `localhost/foreman-code-ci-build:${short}`
  log('fetch-packages')
  // Host networking needs no rootless network helper; only this package-fetch stage has network.
  await podman(['build', '--pull=missing', '--network=host', '--target', 'build', '--layers=true', '--force-rm', '-t', buildTag, buildContext], env)
  const seedRoot = join(installer, `seed-${short}`)
  const seed = join(seedRoot, 'seed')
  await rm(seedRoot, { recursive: true, force: true })
  await mkdir(seed, { recursive: true, mode: 0o700 })
  const container = (await podmanOut(['create', buildTag, 'true'], env)).trim()
  try {
    for (const name of ['pnpm-store', 'corepack-cache']) {
      await podman(['cp', `${container}:/opt/graphql-ci/${name}`, join(seed, name)], env)
    }
  } finally { await podman(['rm', '-f', container], env).catch(() => {}); }

  // 2. Registry release evidence for the strict 48-hour policy, and the Codex binary the unit suite needs.
  log('seed-receipt')
  const needsCodex = expectedPortions(source, 'unit').some(portion => portion.key === 'root:worker-artifact')
  const unitCodex = needsCodex ? await codexBinary(buildTag, seedRoot, env) : undefined
  // pnpm records each project that installed from the store as a symlink; they are not package content.
  for (const version of await readdir(join(seed, 'pnpm-store'))) {
    await rm(join(seed, 'pnpm-store', version, 'projects'), { recursive: true, force: true })
  }
  const receipt = await createSeedReceipt({ repository: source, seed, review })
  const receiptPath = join(seedRoot, 'seed-receipt.json')
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  const offlineSeed: NonNullable<Parameters<typeof buildCiRuntimeContext>[0]['offlineSeed']> = { directory: seed, receiptPath }
  if (unitCodex) {
    offlineSeed.unitCodex = { path: unitCodex.path, binarySha256: unitCodex.sha256, version: unitCodex.version,
      review: receipt.review }
  }

  // 3. The verification image runs Jobs without network.
  const context = join(installer, `context-${short}`)
  await rm(context, { recursive: true, force: true })
  await buildCiRuntimeContext({ repository: source, commit, output: context, offlineSeed })
  // The verified build context now owns the seed copy needed by the image.
  await rm(seed, { recursive: true, force: true })
  const tag = `localhost/foreman-code-verification:${short}`
  log('build-image')
  // The image's own pnpm check runs through the verification policy, which needs a finite memory reservation.
  // Its toolchain layer (with PostgreSQL) is the one the networked package build just cached.
  await podman(['build', '--pull=never', '--network=none', '--memory=2g', '--target', 'verification', '--layers=true', '--force-rm',
    '--label', 'io.foreman-code.installation=ci-verification', '-t', tag, context], env)
  const image = (JSON.parse(await podmanOut(['image', 'inspect', tag], env)) as { Id: string; Digest: string }[])[0]!
  await podman(['rmi', buildTag], env).catch(() => undefined)

  // 4. The exact tracked tree Main approved for this commit, which qualification verifies byte for byte.
  const qualificationSource = await extractQualificationSource(repository, commit,
    join(installer, `qualification-source-${short}`), env)
  // The image holds the seed and context; keep only their receipts and drop the multi-gigabyte build inputs.
  const seedReceiptPath = join(installer, `seed-receipt-${short}.json`), contextReceiptPath = join(installer, `context-receipt-${short}.json`)
  await writeFile(seedReceiptPath, await readFile(join(context, 'seed-receipt.json')), { mode: 0o600 })
  await writeFile(contextReceiptPath, await readFile(join(context, 'context-receipt.json')), { mode: 0o600 })
  // The refresh captures the unit suite's Codex from this copy; the checkout it came from is removed.
  const codex = join(installer, `codex-${short}`)
  if (unitCodex) await writeFile(codex, await readFile(unitCodex.path), { mode: 0o700 })
  for (const path of [context, buildContext, seedRoot]) {
    if (!keepPaths.includes(path)) await rm(path, { recursive: true, force: true })
  }
  await run('git', ['-C', repository, 'worktree', 'remove', '--force', source], { env }).catch(() => undefined)
  const prepared: PreparedCiRuntime = {
    commit, imageId: `sha256:${image.Id.replace(/^sha256:/u, '')}`, imageManifestDigest: image.Digest,
    seedReceiptPath, contextReceiptPath, qualificationSource,
  }
  if (unitCodex) {
    prepared.unitCodex = { executable: '/opt/graphql-ci/tools/codex', sourceExecutable: codex,
      version: unitCodex.version, binarySha256: unitCodex.sha256 }
  }
  await writeCiRuntimeCache({ installer, inputDigest, prepared })
  return prepared
}

export async function codexBinary(image: string, output: string, env: NodeJS.ProcessEnv) {
  // No host paths or credentials are mounted into the package/tool execution boundary.
  const script = `
    const { cpSync, readFileSync } = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const { createRequire } = require('node:module');
    const { dirname, join } = require('node:path');
    cpSync('/opt/graphql-ci/source-lock', '/tmp/source', { recursive: true });
    cpSync('/opt/graphql-ci/pnpm-store', '/tmp/store', { recursive: true });
    cpSync('/opt/graphql-ci/corepack-cache', '/tmp/corepack', { recursive: true });
    execFileSync('/usr/local/bin/node', ['/usr/local/lib/node_modules/corepack/dist/corepack.js',
      'pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/tmp/store'],
      // CI: this disposable copy may carry a node_modules layout from another lockfile; pnpm purges it only non-interactively.
      { cwd: '/tmp/source', env: { ...process.env, CI: 'true', COREPACK_HOME: '/tmp/corepack', COREPACK_ENABLE_NETWORK: '0' },
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const api = createRequire('/tmp/source/apps/api/package.json');
    const launcher = api.resolve('@openai/codex/bin/codex.js');
    const native = createRequire(launcher).resolve('@openai/codex-linux-x64/package.json');
    const binary = join(dirname(native), 'vendor/x86_64-unknown-linux-musl/bin/codex');
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    process.stderr.write(JSON.stringify({ version }));
    process.stdout.write(readFileSync(binary));
  `
  // The binary (hundreds of MB) streams raw to the file; its version arrives on stderr.
  const path = join(output, 'unit-codex')
  await rm(path, { force: true })
  const child = spawn('podman', ['--remote=false', 'run', '--rm', '--pull=never', '--network=none', '--read-only',
    '--cap-drop=all', '--security-opt=no-new-privileges', '--cpus=2', '--memory=2g', '--pids-limit=256',
    '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=8g', '--entrypoint=node', image, '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stderr!.on('data', (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-65_536) })
  await Promise.all([pipeline(child.stdout!, createWriteStream(path, { mode: 0o700, flags: 'wx' })), closed(child, 'Codex capture')])
  const version = (() => { try { return (JSON.parse(diagnostics.slice(diagnostics.lastIndexOf('{'))) as { version?: unknown }).version } catch { return undefined } })()
  const bytes = await readFile(path)
  if (typeof version !== 'string' || !version || !bytes.length) throw new Error('The isolated Codex capture is incomplete.')
  return { path, version, sha256: hash(bytes) }
}

/** Same receipt the CI image policy verifies: every locked release with its registry publish time. */
export async function createSeedReceipt({ repository, seed, review }: { repository: string; seed: string; review: CiRuntimeReview }) {
  const lock = parseCiLock(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  const packages = Object.entries(lock.packages ?? {}).map(([key, value]) => {
    const at = key.lastIndexOf('@')
    return { name: key.slice(0, at), version: key.slice(at + 1), integrity: value.resolution.integrity }
  })
  const names = [...new Set(packages.map(value => value.name))]
  const captured = new Map<string, { metadataPath: string; metadata: { time: Record<string, string> } }>()
  await mkdir(join(seed, 'metadata'), { recursive: true, mode: 0o700 })
  let cursor = 0
  const capture = async () => {
    while (cursor < names.length) {
      const name = names[cursor++]!
      const metadataPath = `metadata/${encodeURIComponent(name)}.json`
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`)
      const metadata = await response.json() as { versions?: Record<string, { dist?: { integrity?: string } }>; time?: Record<string, string>; modified?: string }
      const selected = { name, time: {} as Record<string, string>, versions: {} as Record<string, unknown> }
      for (const pkg of packages.filter(value => value.name === name)) {
        const entry = metadata.versions?.[pkg.version]
        if (!entry || entry.dist?.integrity !== pkg.integrity || !metadata.time?.[pkg.version]) {
          throw new Error(`Registry release differs from the frozen lockfile: ${name}@${pkg.version}`)
        }
        selected.time[pkg.version] = metadata.time[pkg.version]!
        selected.versions[pkg.version] = entry
      }
      await writeFile(join(seed, metadataPath), JSON.stringify(selected), { mode: 0o600 })
      for (const kind of ['metadata', 'metadata-full']) {
        const destination = join(seed, 'registry-cache/v11', kind, 'https%3A+registry.npmjs.org', `${name}.jsonl`)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, `${JSON.stringify({ etag: response.headers.get('etag'), modified: metadata.modified })}\n${JSON.stringify(metadata)}\n`, { mode: 0o600 })
      }
      captured.set(name, { metadataPath, metadata: selected })
    }
  }
  await Promise.all(Array.from({ length: 4 }, capture))
  const tracked = (await run('git', ['-C', repository, 'ls-tree', '-r', '--name-only', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 })).stdout
  const inputPaths = tracked.trim().split('\n').filter(path => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path)).sort()
  const dependencyInputs = await Promise.all(inputPaths.map(async path => ({ path, sha256: hash(await readFile(join(repository, path))) })))
  const files: { path: string; bytes: number; sha256: string }[] = []
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else {
        const file = join(directory, entry.name)
        const info = await lstat(file)
        if (!info.isFile() || info.nlink !== 1) throw new Error(`Nonregular seed entry: ${path}`)
        const bytes = await readFile(file)
        files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
      }
    }
  }
  await walk(seed)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const capturedAt = new Date().toISOString()
  const releases = packages.map(pkg => ({ ...pkg, publishedAt: captured.get(pkg.name)!.metadata.time[pkg.version],
    metadataPath: captured.get(pkg.name)!.metadataPath }))
  return { schemaVersion: 1, packageManager: 'pnpm@11.27.0', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
    minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false, capturedAt,
    provenanceDigest: hash(JSON.stringify({ dependencyInputs, releases, inventory: files })),
    review: { ...review, reviewedAt: capturedAt }, maxBytes: 20 * 2 ** 30, maxInodes: 1_000_000, dependencyInputs, files, packages: releases }
}

const podman = (args: string[], env: NodeJS.ProcessEnv) => run('podman', ['--remote=false', ...args], { env, maxBuffer: 256 * 1024 * 1024 })
const podmanOut = async (args: string[], env: NodeJS.ProcessEnv) => (await podman(args, env)).stdout
const exists = (path: string) => stat(path).then(() => true, () => false)
const closed = (child: ChildProcess, name: string) => new Promise<void>((resolve, reject) => {
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))
})

/** Preparations run one at a time per computer and this installation's container store is theirs alone, so
 * Buildah working containers and build inputs present when one starts were left by an earlier preparation
 * that a Worker restart or an exhausted quota interrupted. Qualification sources still used stay in `keepPaths`. */
export async function reclaimInterruptedPreparation({ repository, installer, keepPaths, env }: {
  repository: string; installer: string; keepPaths: readonly string[]; env: NodeJS.ProcessEnv
}) {
  const containers = JSON.parse(await podmanOut(['ps', '--all', '--external', '--format', 'json'], env) || '[]') as
    { Id: string; State?: string; Command?: string[] | null }[]
  for (const container of containers) {
    // Libpod Job containers are not external; Buildah's are reported in storage state only.
    if (container.State === 'storage' && container.Command?.[0] === 'buildah') await podman(['rm', '--force', container.Id], env)
  }
  const kept = new Set(keepPaths)
  const names = await readdir(installer).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  for (const name of names) {
    const path = join(installer, name)
    if (kept.has(path)) continue
    if (/^source-[a-f0-9]{12}$/u.test(name)) {
      // Another workspace's clone may own the worktree; its own next preparation prunes that record.
      await run('git', ['-C', repository, 'worktree', 'remove', '--force', path], { env }).catch(() => undefined)
      await rm(path, { recursive: true, force: true })
    } else if (/^(?:build-context|context|seed)-[a-f0-9]{12}$|^qualification-source-[a-f0-9]{12}(?:-[A-Za-z0-9]{6})?$/u.test(name)) {
      await rm(path, { recursive: true, force: true })
    }
  }
  await run('git', ['-C', repository, 'worktree', 'prune'], { env }).catch(() => undefined)
}

export async function pruneCiImages(keep: readonly string[], env: NodeJS.ProcessEnv) {
  const kept = new Set(keep.map(id => id.replace(/^sha256:/u, '')))
  const listed = JSON.parse(await podmanOut(['images', '--format', 'json'], env)) as { Id: string; Names?: string[] }[]
  for (const image of listed) {
    if (kept.has(image.Id.replace(/^sha256:/u, ''))) continue
    if (!(image.Names ?? []).some(name => /foreman-code-(?:verification|ci-build)/u.test(name))) continue
    // Podman refuses removal while any execution or Buildah container references the image.
    await podman(['rmi', image.Id], env).catch(error => {
      if (!/in use|used by|associated|container|multiple tags/iu.test(String(error.stderr ?? error.message))) throw error
    })
  }
}

export async function extractQualificationSource(repository: string, commit: string, qualificationSource: string, env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(`${qualificationSource}-`)
  const archive = spawn('git', ['-C', repository, 'archive', '--format=tar', commit], { env })
  const extract = spawn('/bin/sh', ['-c', 'umask 077 && exec tar -x -C "$1"', 'sh', directory], { env })
  // tar may stop reading at the end-of-archive marker before git writes its trailing padding; both exit
  // codes still decide success, so only that early close of the pipe is not a failure.
  const copy = pipeline(archive.stdout, extract.stdin).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  })
  const tasks = [copy, closed(archive, 'git archive'), closed(extract, 'tar')]
  try {
    await Promise.all(tasks)
    return directory
  } catch (error) {
    archive.kill()
    extract.kill()
    await Promise.allSettled(tasks)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
