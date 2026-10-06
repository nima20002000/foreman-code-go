import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)

test('remote dispatch executes the accepted commit after its original checkout changes while queued', async () => {
  const dispatcher = process.env.FOREMAN_CODE_TEST_DISPATCHER
  assert.ok(dispatcher, 'Provide the actual reviewed dispatcher on this machine.')
  const home = await mkdtemp(join(tmpdir(), 'dispatch-source-'))
  const orchestration = join(home, 'Desktop/graphql-worktrees/_orchestration')
  const worktree = join(home, 'Desktop/graphql-worktrees/integration-20261004/hc')
  const queue = join(orchestration, 'testq')
  const bin = join(home, 'bin')
  let child
  try {
    await Promise.all([worktree, queue, bin, join(orchestration, 'remote'), join(orchestration, 'integration'),
      join(home, 'Desktop/graphql-worktrees/.snap')].map(path => mkdir(path, { recursive: true })))
    const environment = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' }
    const git = (...args) => execute('git', ['-C', worktree, ...args], { env: environment })
    await git('init', '-q', '-b', 'main')
    await writeFile(join(worktree, 'program.mjs'), 'process.stdout.write(JSON.stringify({value: 1}))\n')
    await git('add', 'program.mjs')
    await git('commit', '-qm', 'Accepted source')
    const commit = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('update-ref', 'refs/remotes/origin/main', commit)
    await writeFile(join(queue, 'hc-request.md'), `commit: ${commit}\nmachine: any\n\n\`\`\`sh\nnode program.mjs > "$HOME/observed.json"\n\`\`\`\n`)
    await writeFile(join(orchestration, 'integration/hc.handedoff'), '')
    await writeFile(join(orchestration, 'remote/janitor.py'), '')
    // SSH/transfer boundaries are recorded; this exercises the real dispatcher's source capture, not a native harness.
    for (const name of ['ssh', 'scp']) await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(join(orchestration, 'remote/remote-run.sh'), `#!/bin/sh
set -eu
root="$3"
shift 4
touch "$HOME/admitted"
while [ ! -f "$HOME/release" ]; do sleep 0.05; done
cd "$root"
exec "$@"
`, { mode: 0o700 })
    const program = join(queue, 'dispatch.sh')
    await copyFile(dispatcher, program)
    child = spawn('bash', [program, 'hc', 'dexter'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code))
    })
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try { await readFile(join(home, 'admitted')); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (child.exitCode !== null) throw new Error(`Dispatcher exited before admission: ${output}`)
      await delay(25)
    }
    await readFile(join(home, 'admitted'))
    await writeFile(join(worktree, 'dependency.mjs'), 'export const value = 2\n')
    await writeFile(join(worktree, 'program.mjs'), "import {value} from './dependency.mjs'; process.stdout.write(JSON.stringify({value}))\n")
    await writeFile(join(home, 'release'), '')
    assert.equal(await completed, 0, output)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'observed.json'), 'utf8')), { value: 1 })
    assert.equal((await execute('node', ['program.mjs'], { cwd: worktree })).stdout, '{"value":2}')
    assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), commit)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    await rm(home, { recursive: true, force: true })
  }
}, { timeout: 20000 })
