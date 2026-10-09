import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { codexBinary, extractQualificationSource, prepareCiRuntime, pruneCiImages, reclaimInterruptedPreparation }
  from './ciRuntimePrepare.js'
import { PreparedCiRuntimeSchema } from '@foreman-code/contracts'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'

const command = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const run = promisify(actual.execFile)
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[], options: unknown) => {
      if (file === 'podman' || file === 'corepack') return { stdout: await command.run(file, args), stderr: '' }
      return run(file, args, options as Parameters<typeof run>[2])
    },
  })
  // Streamed podman runs answer from the same fake: { stdout: Buffer, stderr: string }.
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const spawn = ((file: string, args: string[], options: unknown) => {
    if (file !== 'podman') return actual.spawn(file, args, options as Parameters<typeof actual.spawn>[2])
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    void Promise.resolve(command.run(file, args)).then((result: { stdout: Buffer; stderr: string }) => {
      child.stderr.end(result.stderr); child.stdout.end(result.stdout)
      child.stdout.once('end', () => child.emit('close', 0))
    }, (error: unknown) => { child.stdout.end(); child.stderr.end(); child.emit('error', error) })
    return child
  }) as unknown as typeof actual.spawn
  return { ...actual, execFile, spawn }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  command.run.mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repository() {
  const root = await privateFixtureDirectory('ci-preparation-')
  roots.push(root)
  const source = join(root, 'repository')
  await mkdir(source)
  execFileSync('git', ['init', source], { stdio: 'ignore' })
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' })
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  await writeFile(join(source, 'a-first.txt'), 'first')
  await writeFile(join(source, 'z-last.txt'), 'complete')
  const save = () => {
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD').trim()
  }
  return { root, source, save }
}

describe('CI runtime preparation boundaries', () => {
  it.each([
    { code: 125, stderr: 'Error: writing layer: disk quota exceeded', worker: false },
    { code: 'ENOSPC', stderr: '', worker: false },
    { code: 'EDQUOT', stderr: '', worker: true },
  ])('reports CI storage exhaustion with the installer project quota: $code', async failure => {
    const f = await repository()
    const commit = f.save()
    const installer = join(f.root, 'installer')
    await mkdir(installer)
    const pool = verificationCapacityFixture('main').measurement!.fingerprint.quotaPool!
    const observed = { volumeCapacityBytes: 64 * 2 ** 30, volumeCapacityInodes: pool.volumeCapacityInodes,
      projectId: 1, inheritance: true, hardLimitBytes: 1048576, hardInodes: 1000,
      usedBytes: 1044480, usedInodes: 990, accountingEnabled: true, filesystem: pool.slots[0]!.filesystem }
    const observer = join(f.root, 'quota-query')
    const script = `#!/bin/sh\n[ "$1" = '${installer}' ] || exit 1\nprintf '%s' '${JSON.stringify(observed)}'\n`
    await writeFile(observer, script, { mode: 0o700 })
    const state = failure.worker ? join(f.root, 'worker-state') : f.root
    if (failure.worker) await mkdir(state)
    await writeFile(join(state, 'job-runtime.json'), JSON.stringify({ schemaVersion: 2,
      descriptor: { quotaPool: { ...pool, queryExecutable: observer,
        queryBinarySha256: createHash('sha256').update(script).digest('hex') } } }), { mode: 0o600 })
    command.run.mockRejectedValue(Object.assign(new Error('podman failed'), failure))

    await expect(prepareCiRuntime({ repository: f.source, commit, installer, stateDirectory: state,
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'a'.repeat(64) } }))
      .rejects.toThrow('CI storage is full on this build computer. Control quota (project 1): '
        + 'bytes used=1044480 hard=1048576; inodes used=990 hard=1000.')
  })

  it('reports storage exhaustion even when the protected quota readback is unavailable', async () => {
    const f = await repository()
    const commit = f.save()
    command.run.mockRejectedValue(new Error('write: no space left on device'))
    await expect(prepareCiRuntime({ repository: f.source, commit, installer: join(f.root, 'installer'),
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'a'.repeat(64) } }))
      .rejects.toThrow('CI storage is full on this build computer. Control quota readback unavailable:')
  })

  it('preserves an unrelated preparation failure', async () => {
    const f = await repository()
    const commit = f.save()
    const failure = new Error('Podman storage configuration is invalid')
    command.run.mockRejectedValue(failure)
    await expect(prepareCiRuntime({ repository: f.source, commit, installer: join(f.root, 'installer'),
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'a'.repeat(64) } })).rejects.toBe(failure)
  })

  it('prepares another project from its own dependency seed without requiring the Foreman Codex package', async () => {
    const f = await repository()
    await writeFile(join(f.source, 'package.json'), JSON.stringify({ name: 'ordinary-project',
      packageManager: 'pnpm@11.27.0', scripts: { build: 'node build.mjs', lint: 'node lint.mjs', test: 'node --test' } }))
    await writeFile(join(f.source, 'pnpm-lock.yaml'),
      'lockfileVersion: 9\npackages:\n  fixture@1.0.0:\n    resolution:\n      integrity: sha512-fixture\n')
    await writeFile(join(f.source, 'pnpm-workspace.yaml'),
      'minimumReleaseAge: 2880\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\n')
    const commit = f.save()
    const installer = join(f.root, 'installer')
    await mkdir(installer, { mode: 0o700 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      name: 'fixture', time: { '1.0.0': '2025-01-01T00:00:00.000Z' },
      versions: { '1.0.0': { dist: { integrity: 'sha512-fixture' } } },
    })))
    command.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('images') || args.includes('ps')) return '[]'
      if (args.includes('create')) return 'container'
      if (args.includes('cp')) {
        const destination = args.at(-1)!
        await mkdir(join(destination, 'v11'), { recursive: true })
        await writeFile(join(destination, 'v11/package-bytes'), 'locked fixture content')
      }
      if (args.includes('inspect')) return JSON.stringify([{ Id: 'a'.repeat(64), Digest: `sha256:${'b'.repeat(64)}` }])
      if (args.includes('run')) throw new Error('This project does not require a native harness')
      return ''
    })
    const prepared = await prepareCiRuntime({ repository: f.source, commit, installer,
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'a'.repeat(64) } })
    expect(PreparedCiRuntimeSchema.parse(prepared).unitCodex).toBeUndefined()
    expect(prepared.commit).toBe(commit)
    const seed = JSON.parse(await readFile(prepared.seedReceiptPath, 'utf8')) as { packages: { name: string }[] }
    expect(seed.packages.map(pkg => pkg.name)).toEqual(['fixture'])
    expect(await readFile(join(prepared.qualificationSource, 'package.json'), 'utf8'))
      .toBe(await readFile(join(f.source, 'package.json'), 'utf8'))

    const originalReceipt = await readFile(prepared.seedReceiptPath)
    const installedReceipt = join(installer, `seed-receipt-${commit.slice(0, 12)}.json`)
    await writeFile(installedReceipt, originalReceipt, { mode: 0o600 })
    // A missing image cache forces a rebuild of the same commit with another review.
    await rm(join(installer, 'runtime-cache'), { recursive: true })
    const rebuilt = await prepareCiRuntime({ repository: f.source, commit, installer,
      keepPaths: [prepared.seedReceiptPath, installedReceipt, prepared.qualificationSource],
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'b'.repeat(64) } })
    expect(rebuilt.seedReceiptPath).not.toBe(prepared.seedReceiptPath)
    expect(await readFile(prepared.seedReceiptPath)).toEqual(originalReceipt)
    expect(await readFile(installedReceipt)).toEqual(originalReceipt)
    expect(await readFile(join(prepared.qualificationSource, 'package.json'), 'utf8'))
      .toBe(await readFile(join(f.source, 'package.json'), 'utf8'))
    const rebuiltReceipt = JSON.parse(await readFile(rebuilt.seedReceiptPath, 'utf8'))
    expect(rebuiltReceipt.review.decisionDigest).toBe('b'.repeat(64))
  })

  it('does not execute the requested commit\'s context builder on the Worker host', async () => {
    const f = await repository()
    const marker = join(f.root, 'outside-installer')
    await mkdir(join(f.source, 'scripts'))
    await writeFile(join(f.source, 'scripts/build-ci-runtime-context.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe'); throw Error('Repository code executed');`)
    await writeFile(join(f.source, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.27.0' }))
    await writeFile(join(f.source, 'pnpm-lock.yaml'), 'packages: {}\n')
    await writeFile(join(f.source, 'pnpm-workspace.yaml'),
      'minimumReleaseAge: 2880\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\n')
    const control = join(f.source, 'apps/worker/artifacts/ci-runtime')
    await mkdir(control, { recursive: true })
    for (const name of ['Containerfile', 'corepack']) await writeFile(join(control, name), 'fixture')
    const commit = f.save()
    const installer = join(f.root, 'installer')
    await mkdir(installer, { mode: 0o700 })
    command.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('build')) throw new Error('Stopped at isolated image build')
      return '[]'
    })
    await expect(prepareCiRuntime({ repository: f.source, commit, installer,
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'a'.repeat(64) } }))
      .rejects.toThrow('Stopped at isolated image build')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims build inputs and Buildah containers an interrupted preparation left, keeping used sources', async () => {
    const f = await repository()
    f.save()
    const installer = join(f.root, 'installer')
    await mkdir(installer, { mode: 0o700 })
    const short = 'a'.repeat(12)
    const source = join(installer, `source-${short}`)
    execFileSync('git', ['-C', f.source, 'worktree', 'add', '--detach', source], { stdio: 'ignore' })
    const leftovers = [`build-context-${short}`, `context-${short}`, `seed-${short}`, `qualification-source-${short}-AbC123`]
    const kept = [`qualification-source-${'b'.repeat(12)}-XyZ789`, `seed-receipt-${short}.json`, `codex-${short}`, 'runtime-cache']
    for (const name of [...leftovers, ...kept]) {
      if (name.endsWith('.json') || name.startsWith('codex-')) await writeFile(join(installer, name), 'retained')
      else await mkdir(join(installer, name, 'nested'), { recursive: true })
    }
    command.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('ps')) return JSON.stringify([
        { Id: 'interrupted-build', State: 'storage', Command: ['buildah'] },
        { Id: 'job-container', State: 'exited', Command: ['node'] },
      ])
      return ''
    })
    await reclaimInterruptedPreparation({ repository: f.source, installer, env: process.env,
      keepPaths: [join(installer, kept[0]!)] })
    expect((await readdir(installer)).sort()).toEqual([...kept].sort())
    expect(command.run.mock.calls.filter(([, args]) => (args as string[]).includes('rm')).map(([, args]) => args))
      .toEqual([['--remote=false', 'rm', '--force', 'interrupted-build']])
    expect(execFileSync('git', ['-C', f.source, 'worktree', 'list'], { encoding: 'utf8' })).not.toContain(source)
  })

  it('extracts the locked Codex binary and reads its version without executing it on the host', async () => {
    const f = await repository()
    const marker = join(f.root, 'codex-host-marker')
    const packageRoot = join(f.source, 'apps/api/node_modules/@openai/codex')
    const nativeRoot = join(packageRoot, 'node_modules/@openai/codex-linux-x64')
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await mkdir(join(nativeRoot, 'vendor/x86_64-unknown-linux-musl/bin'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ exports: { './bin/codex.js': './bin/codex.js' } }))
    await writeFile(join(packageRoot, 'bin/codex.js'), '')
    await writeFile(join(nativeRoot, 'package.json'), '{}')
    const bytes = Buffer.from(`#!/bin/sh\nprintf unsafe > '${marker}'\nprintf codex-cli-fixture\n`)
    await writeFile(join(nativeRoot, 'vendor/x86_64-unknown-linux-musl/bin/codex'), bytes, { mode: 0o700 })
    const seed = join(f.root, 'seed')
    await mkdir(seed)
    command.run.mockImplementation(async (file, args: string[]) => {
      if (file === 'corepack') return ''
      expect(args).toEqual(expect.arrayContaining(['run', '--network=none', '--read-only', '--cap-drop=all',
        '--security-opt=no-new-privileges', '--memory=2g', '--pids-limit=256']))
      expect(args.some(arg => arg.startsWith('--volume') || arg.startsWith('--mount'))).toBe(false)
      return { stdout: bytes, stderr: JSON.stringify({ version: 'codex-cli-fixture' }) }
    })
    const result = await codexBinary(f.source, seed, process.env)
    expect(result.version).toBe('codex-cli-fixture')
    expect(await readFile(result.path)).toEqual(bytes)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(command.run.mock.calls.some(([file, args]) => file === 'podman' && args.includes('run'))).toBe(true)
  })

  it('keeps active Buildah containers and retained execution containers while pruning unused CI images', async () => {
    const containers = new Map([['build', 'building'], ['recovery', 'old']])
    const images = new Set(['building', 'old', 'unused'])
    command.run.mockImplementation(async (_file, argv: string[]) => {
      const args = argv.slice(1)
      if (args[0] === 'ps') return JSON.stringify([{ Id: 'build', Names: ['image-working-container'] },
        { Id: 'recovery', Names: ['retained-job'] }])
      if (args[0] === 'images') return JSON.stringify([...images].map(Id => ({ Id,
        Names: [`localhost/foreman-code-verification:${Id}`] })))
      if (args[0] === 'rm') containers.delete(args.at(-1)!)
      if (args[0] === 'rmi') {
        const id = args.at(-1)!
        if ([...containers.values()].includes(id)) {
          if (!args.includes('-f')) throw new Error('Image is in use')
          for (const [container, image] of containers) if (image === id) containers.delete(container)
        }
        images.delete(id)
      }
      return ''
    })
    await pruneCiImages([], process.env)
    expect([...containers.keys()].sort()).toEqual(['build', 'recovery'])
    expect([...images].sort()).toEqual(['building', 'old'])
  })

  it('rebuilds the qualification tree after an interrupted extraction of the same commit', async () => {
    const f = await repository()
    const commit = f.save()
    const bin = join(f.root, 'bin')
    const interrupt = join(f.root, 'interrupt')
    await mkdir(bin)
    await writeFile(interrupt, '')
    await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ -f '${interrupt}' ]; then\n/usr/bin/git "$@" | head -c 1024\nexit 1\nfi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 })
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    const destination = join(f.root, 'qualification-source')
    await expect(extractQualificationSource(f.source, commit, destination, env)).rejects.toThrow()
    await rm(interrupt)
    const source = await extractQualificationSource(f.source, commit, destination, env)
    expect(await readFile(join(source, 'z-last.txt'), 'utf8')).toBe('complete')
    expect(await readFile(join(source, 'a-first.txt'), 'utf8')).toBe('first')
  })
})
