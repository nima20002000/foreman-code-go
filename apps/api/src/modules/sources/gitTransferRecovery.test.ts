import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
import { fetchingApi, interruptedFetchWriter } from '../../../test/helpers/interruptedGitFetch.js'

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

/** Locks and partial packs a killed fetch leaves in the common directory; Git closed each before it died. */
const fetchArtifacts = { 'shallow.lock': 41, 'FETCH_HEAD.lock': 41, 'packed-refs.lock': 0,
  'refs/remotes/origin/main.lock': 41, 'refs/foreman/ci/fetch/interrupted.lock': 41,
  'objects/pack/tmp_pack_interrupted': 4096, 'objects/pack/tmp_idx_interrupted': 1024 }

async function expectRemoved(common: string, names: string[]) {
  for (const name of names) await expect(readFile(join(common, name))).rejects.toMatchObject({ code: 'ENOENT' })
}

it('recovers a cancelled fetch’s unobserved locks on the next acquisition and preserves published data', async () => {
  const f = await recoveryFixture()
  let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('successor')
    const common = join(clone, '.git')
    const before = await readFile(join(common, 'shallow'))
    writer = await interruptedFetchWriter(f.root, common, fetchArtifacts)
    const controller = new AbortController()
    const running = runGitWithCacheStorage(f.cache, ['fetch', 'origin', successor],
      { cwd: clone, signal: controller.signal },
      (args, options) => runGitProcess(args.includes('fetch') ? writer!.args : args, options, f.environment))
    await (await writer.started()).write()
    controller.abort()
    await expect(running).resolves.toMatchObject({ code: 1 })
    expect(await readFile(join(common, 'shallow'))).toEqual(before)
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.first)

    await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
    await expectRemoved(common, Object.keys(fetchArtifacts))
  } finally {
    writer?.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('recovers a fetch whose API died before its surviving writer created locks', async () => {
  const f = await recoveryFixture()
  let api: ChildProcess | undefined
  let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
  try {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
    const successor = await f.commit('after restart')
    const common = join(clone, '.git')
    writer = await interruptedFetchWriter(f.root, common, fetchArtifacts)
    api = await fetchingApi(f.root, f.cache, clone, writer.args, f.environment)
    const transfer = await writer.started()
    await stop(api)
    await transfer.write()
    await transfer.die()

    // A fresh process keeps nothing from the lost API: only the cache and the repository remain.
    const system = systemGitWorktreePorts(f.environment)
    await expect(ensureCommit(system, 'fixture/project', successor, signal)).resolves.toBe(clone)
    expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
    await expectRemoved(common, Object.keys(fetchArtifacts))
    expect((await readdir(f.cache)).filter(name => name.endsWith('.reservation'))).toEqual([])
  } finally {
    if (api) await stop(api)
    writer?.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

/** An Agent's `git update-ref` in its linked worktree, paused in its reference-transaction hook with its locks held. */
async function liveAgentWriter(root: string, worktree: string, environment: NodeJS.ProcessEnv, input: string) {
  const hooks = join(root, 'agent-hooks')
  await mkdir(hooks, { mode: 0o700 })
  const address = `\0foreman-agent-writer-${randomUUID()}`
  const helper = join(hooks, 'prepared.mjs')
  await writeFile(helper, `
    import { connect } from 'node:net';
    const socket = connect(${JSON.stringify(address)});
    socket.on('connect', () => socket.write('prepared'));
    socket.on('data', () => process.exit(0));
  `)
  await writeFile(join(hooks, 'reference-transaction'),
    `#!/bin/sh\n[ "$1" = prepared ] || exit 0\nexec '${process.execPath}' '${helper}'\n`, { mode: 0o700 })
  const server = createServer()
  server.listen(address)
  await once(server, 'listening')
  let socket: Socket | undefined
  let child: ChildProcess | undefined
  return {
    async start() {
      const connected = once(server, 'connection')
      child = spawn('git', ['-c', `core.hooksPath=${hooks}`, 'update-ref', '--stdin'],
        { cwd: worktree, env: environment, stdio: ['pipe', 'ignore', 'inherit'] })
      child.stdin!.end(input)
      ;[socket] = await connected as [Socket]
      await once(socket, 'data')
    },
    async finish() {
      const exited = once(child!, 'exit')
      socket!.write('continue')
      return (await exited)[0] as number | null
    },
    async close() {
      socket?.destroy()
      server.close()
      if (child) await stop(child)
    },
  }
}

it.each(['before', 'during'] as const)(
  'keeps the locks of an Agent Git writer started %s a cancelled fetch until it finishes, then recovers the fetch',
  async phase => {
    const f = await recoveryFixture()
    let writer: Awaited<ReturnType<typeof interruptedFetchWriter>> | undefined
    let agent: Awaited<ReturnType<typeof liveAgentWriter>> | undefined
    try {
      const signal = AbortSignal.timeout(30_000)
      const clone = await ensureCommit(f.ports, 'fixture/project', f.first, signal)
      const successor = await f.commit('successor')
      const common = join(clone, '.git')
      const worktree = join(f.root, 'agent')
      f.git(clone, 'worktree', 'add', '-q', '-b', 'foreman/agent', worktree, f.first)
      f.git(clone, 'branch', 'foreman/obsolete', f.first)
      agent = await liveAgentWriter(f.root, worktree, f.environment,
        `create refs/remotes/origin/agent-push ${f.first}\ndelete refs/heads/foreman/obsolete\n`)
      const agentLocks = ['refs/remotes/origin/agent-push.lock', 'refs/heads/foreman/obsolete.lock', 'packed-refs.lock']
      const interrupted = { 'shallow.lock': 41, 'refs/foreman/ci/fetch/interrupted.lock': 41,
        'objects/pack/tmp_pack_interrupted': 4096 }
      writer = await interruptedFetchWriter(f.root, common, interrupted)
      if (phase === 'before') await agent.start()
      const controller = new AbortController()
      const running = runGitWithCacheStorage(f.cache, ['fetch', 'origin', successor],
        { cwd: clone, signal: controller.signal },
        (args, options) => runGitProcess(args.includes('fetch') ? writer!.args : args, options, f.environment))
      await (await writer.started()).write()
      if (phase === 'during') await agent.start()
      controller.abort()
      await expect(running).resolves.toMatchObject({ code: 1 })
      // Recovery waits for the live writer instead of guessing which same-named locks are abandoned.
      await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).rejects.toThrow()
      for (const name of agentLocks) await expect(stat(join(common, name))).resolves.toBeTruthy()

      expect(await agent.finish()).toBe(0)
      expect(f.git(worktree, 'rev-parse', 'refs/remotes/origin/agent-push')).toBe(f.first)
      expect(f.git(clone, 'branch', '--list', 'foreman/obsolete')).toBe('')
      await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
      expect(f.git(clone, 'cat-file', '-t', successor)).toBe('commit')
      await expectRemoved(common, Object.keys(interrupted))
    } finally {
      await agent?.close()
      writer?.close()
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

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
