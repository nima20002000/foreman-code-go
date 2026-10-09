import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { codexBinary, extractQualificationSource, prepareCiRuntime, pruneCiImages } from './ciRuntimePrepare.js'

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
    await mkdir(installer)
    command.run.mockImplementation(async (_file, args: string[]) => {
      if (args.includes('build')) throw new Error('Stopped at isolated image build')
      return '[]'
    })
    await expect(prepareCiRuntime({ repository: f.source, commit, installer,
      review: { reviewedByPrincipalId: 'owner', decisionDigest: 'a'.repeat(64) } }))
      .rejects.toThrow('Stopped at isolated image build')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
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
