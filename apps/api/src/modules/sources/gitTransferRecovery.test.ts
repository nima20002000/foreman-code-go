import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SOURCE_GIT_CACHE_LIMITS } from '@foreman-code/contracts/source-materialization'
import { runGitWithCacheStorage } from './gitCacheStorage.js'
import { runGitProcess } from './gitProcess.js'
import { ensureClone, ensureCommit, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { deferred } from '../../../test/helpers/deferred.js'

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

it('charges detached Git writers after their API exits, then reclaims abandoned clone staging', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-transfer-recovery-'))
  const cache = join(root, 'cache')
  const staging = join(cache, 'abandoned-clone')
  const origin = join(root, 'origin')
  const socketName = `foreman-git-${randomUUID()}`
  const server = createServer()
  let api: ChildProcess | undefined
  let writer: Socket | undefined
  let waiter: ChildProcess | undefined
  let next: Promise<unknown> | undefined
  const entered = deferred()
  const resume = deferred()
  try {
    await mkdir(cache, { mode: 0o700 })
    await mkdir(origin, { mode: 0o700 })
    execFileSync('git', ['init', '--template=', '-q', '-b', 'main'], { cwd: origin, env: gitFixtureEnvironment() })
    const helper = join(root, 'remote.mjs')
    await writeFile(helper, `
      import { connect } from 'node:net';
      import { writeFile } from 'node:fs/promises';
      const socket = connect('\\0' + process.argv[2]);
      socket.on('connect', () => socket.write(String(process.pid) + '\\n'));
      socket.on('data', async command => {
        if (String(command).trim() === 'write') {
          await writeFile(process.argv[3] + '/writer.bin', 'orphan still writing');
          socket.write('written\\n');
        } else process.exit(0);
      });
    `)
    const launcher = join(root, 'api.mjs')
    await writeFile(launcher, `
      import { runGitWithCacheStorage } from ${JSON.stringify(new URL('./gitCacheStorage.ts', import.meta.url).href)};
      import { runGitProcess } from ${JSON.stringify(new URL('./gitProcess.ts', import.meta.url).href)};
      const [cache, helper, socket, target] = process.argv.slice(2);
      const remote = 'ext::' + process.execPath + ' ' + helper + ' ' + socket + ' ' + target;
      await runGitWithCacheStorage(cache, ['-c', 'protocol.ext.allow=always', 'clone', remote, target],
        { signal: new AbortController().signal }, (args, options) => runGitProcess(args, options, process.env));
    `)
    const connected = once(server, 'connection')
    server.listen('\0' + socketName)
    await once(server, 'listening')
    api = spawn(process.execPath, ['--import', 'tsx', launcher,
      cache, helper, socketName, staging], { env: gitFixtureEnvironment(), stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    api.stderr!.on('data', chunk => { errors += String(chunk) })
    const exitedEarly = once(api, 'exit').then(() => { throw new Error(`Git API exited before its writer: ${errors}`) })
    const connection = await Promise.race([connected, exitedEarly]) as [Socket]
    writer = connection[0]
    const [pid] = await once(writer, 'data')
    waiter = spawn('python3', ['-c',
      'import os,select,sys; fd=os.pidfd_open(int(sys.argv[1])); print("ready",flush=True); select.select([fd],[],[])',
      String(pid).trim()], { stdio: ['ignore', 'pipe', 'inherit'] })
    await once(waiter.stdout!, 'data')
    await stop(api)
    const written = once(writer, 'data')
    writer.write('write\n')
    expect(String((await written)[0]).trim()).toBe('written')
    expect(await readFile(join(staging, 'writer.bin'), 'utf8')).toBe('orphan still writing')

    const target = join(cache, 'next-clone')
    next = runGitWithCacheStorage(cache, ['clone', origin, target], { signal: new AbortController().signal },
      async (args, options) => {
        entered.resolve()
        await resume.promise
        return runGitProcess(args, options, gitFixtureEnvironment())
      })
    await entered.promise
    const storage = JSON.parse(await readFile(join(cache, 'storage.json'), 'utf8')) as { reservedBytes: number }
    expect(storage.reservedBytes).toBe(2 * SOURCE_GIT_CACHE_LIMITS.transferBytes)
    expect(await readFile(join(staging, 'writer.bin'), 'utf8')).toBe('orphan still writing')
    resume.resolve()
    await next
    const writerExited = once(waiter, 'exit')
    writer.write('exit\n')
    await writerExited
    await runGitWithCacheStorage(cache, ['clone', origin, join(cache, 'after-closure')],
      { signal: new AbortController().signal }, (args, options) => runGitProcess(args, options, gitFixtureEnvironment()))
    await expect(readFile(join(staging, 'writer.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(cache)).filter(name => name.endsWith('.reservation'))).toEqual([])
    expect(JSON.parse(await readFile(join(cache, 'storage.json'), 'utf8'))).toMatchObject({ reservedBytes: 0 })
  } finally {
    resume.resolve()
    await next
    if (api) await stop(api)
    if (writer && !writer.destroyed) {
      const writerExited = waiter && waiter.exitCode === null && waiter.signalCode === null
        ? once(waiter, 'exit') : undefined
      writer.write('exit\n')
      await writerExited
      writer.destroy()
    } else if (waiter) await stop(waiter)
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function recoveryFixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-cache-recovery-'))
  const home = join(root, 'home')
  const origin = join(root, 'origin')
  await mkdir(home, { mode: 0o700 })
  await mkdir(origin, { mode: 0o700 })
  const environment = { ...gitFixtureEnvironment(), HOME: home }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
    { cwd, env: environment, encoding: 'utf8' }).trim()
  git(origin, 'init', '--template=', '-q', '-b', 'main')
  const commit = async (content: string) => {
    await writeFile(join(origin, 'source.txt'), content)
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', content)
    return git(origin, 'rev-parse', 'HEAD')
  }
  const first = await commit('first')
  const system = systemGitWorktreePorts(environment)
  const ports: GitWorktreePorts = { cloneDirectory: system.cloneDirectory,
    git: (args, options) => system.git(args.map(arg => arg === 'https://github.com/fixture/project.git'
      ? `file://${origin}` : arg), options) }
  const cache = join(home, '.local', 'share', 'foreman-code', 'git')
  return { root, home, origin, environment, git, commit, first, ports, cache }
}

const fetchLocks = ['shallow.lock', 'FETCH_HEAD.lock', 'packed-refs.lock', 'refs/remotes/origin/main.lock']

it('removes failed fetch locks after its writers close and preserves published repository data', async () => {
  const f = await recoveryFixture()
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('successor')
    const common = join(clone, '.git')
    const before = await readFile(join(common, 'shallow'))
    const failed = await runGitWithCacheStorage(f.cache, ['fetch', 'origin', successor], { cwd: clone, signal },
      async (args, options) => {
        if (!args.includes('fetch')) return runGitProcess(args, options, f.environment)
        // A killed Git writer leaves these files without publishing their contents.
        for (const name of fetchLocks) await writeFile(join(common, name), before)
        await writeFile(join(common, 'objects', 'pack', 'tmp_pack_interrupted'), 'incomplete pack')
        return { code: 1, stdout: '', stderr: 'Git writer was killed' }
      })
    expect(failed.code).toBe(1)
    for (const name of [...fetchLocks, 'objects/pack/tmp_pack_interrupted']) {
      await expect(readFile(join(common, name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(join(common, 'shallow'))).toEqual(before)
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.first)
    await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('recovers abandoned fetch locks before fetching after a restart', async () => {
  const f = await recoveryFixture()
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('after restart')
    for (const name of fetchLocks) await writeFile(join(clone, '.git', name), 'abandoned')
    await writeFile(join(clone, '.git', 'objects', 'pack', 'tmp_pack_abandoned'), 'incomplete pack')
    const system = systemGitWorktreePorts(f.environment)
    const restarted: GitWorktreePorts = { cloneDirectory: system.cloneDirectory, git: system.git }
    await expect(ensureCommit(restarted, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
    for (const name of [...fetchLocks, 'objects/pack/tmp_pack_abandoned']) {
      await expect(readFile(join(clone, '.git', name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('recovers clone staging when the API exits as the clone command returns', async () => {
  const f = await recoveryFixture()
  let api: ChildProcess | undefined
  try {
    const launcher = join(f.root, 'clone-api.mjs')
    await writeFile(launcher, `
      import { ensureClone, systemGitWorktreePorts } from ${JSON.stringify(new URL('./gitWorktree.ts', import.meta.url).href)};
      const [home, origin] = process.argv.slice(2);
      const system = systemGitWorktreePorts({ ...process.env, HOME: home });
      const ports = { cloneDirectory: system.cloneDirectory, git: async (args, options) => {
        const result = await system.git(args.map(arg => arg === 'https://github.com/fixture/project.git'
          ? 'file://' + origin : arg), options);
        if (args[0] === 'clone' && result.code === 0) {
          process.send({ staging: args.at(-1) });
          await new Promise(resolve => process.once('message', resolve));
        }
        return result;
      } };
      await ensureClone(ports, 'fixture/project', new AbortController().signal);
    `)
    api = spawn(process.execPath, ['--import', 'tsx', launcher, f.home, f.origin],
      { env: f.environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let errors = ''
    api.stderr!.on('data', chunk => { errors += String(chunk) })
    const earlyExit = once(api, 'exit').then(() => { throw new Error(`Clone API exited early: ${errors}`) })
    const [message] = await Promise.race([once(api, 'message'), earlyExit]) as [{ staging: string }]
    await stop(api)
    const clone = await ensureClone(f.ports, 'fixture/project', AbortSignal.timeout(30_000))
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.first)
    await expect(readFile(join(message.staging, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(f.cache)).filter(name => name.endsWith('.reservation'))).toEqual([])
  } finally {
    if (api) await stop(api)
    await rm(f.root, { recursive: true, force: true })
  }
})

it('preserves live completed staging across competing publication and removes its recovery record afterward', async () => {
  const f = await recoveryFixture()
  const entered = deferred()
  const resume = deferred()
  let preparing: Promise<string> | undefined
  let staging: string | undefined
  try {
    const signal = AbortSignal.timeout(30_000)
    const held: GitWorktreePorts = { cloneDirectory: f.ports.cloneDirectory, git: async (args, options) => {
      const result = await f.ports.git(args, options)
      if (args[0] === 'clone' && result.code === 0) {
        staging = args.at(-1)!
        entered.resolve()
        await resume.promise
      }
      return result
    } }
    preparing = ensureClone(held, 'fixture/project', signal)
    await entered.promise
    const clone = await ensureClone(f.ports, 'fixture/project', signal)
    expect(await readFile(join(staging!, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(JSON.parse(await readFile(join(f.cache, 'storage.json'), 'utf8'))).toMatchObject({ reservedBytes: 0 })
    resume.resolve()
    await expect(preparing).resolves.toBe(clone)
    const successor = await f.commit('after competing publication')
    await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect((await readdir(f.cache)).filter(name => /\.(?:reservation|staging)$/u.test(name))).toEqual([])
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
  } finally {
    resume.resolve()
    await preparing
    await rm(f.root, { recursive: true, force: true })
  }
})
