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
