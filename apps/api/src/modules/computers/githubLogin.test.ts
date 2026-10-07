import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { GitHubLoginRunner, type GitHubLoginPorts } from './githubLogin.js'

function fixture(installed = true) {
  let user: string | null = null
  const children: { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; emitter: EventEmitter; kill: ReturnType<typeof vi.fn>; args: string[] }[] = []
  const runs: string[] = []
  const ports: GitHubLoginPorts = {
    now: () => Date.parse('2026-10-07T00:00:00Z'),
    spawn: (_binary, args) => {
      const emitter = new EventEmitter()
      const child = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), emitter, args,
        kill: vi.fn(() => { emitter.emit('exit', null) }) }
      children.push(child)
      return { stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, kill: child.kill,
        once: (event: string, listener: (...values: unknown[]) => void) => { emitter.once(event, listener); return undefined as never } } as never
    },
    probe: {
      environment: {},
      find: async name => installed && name === 'gh' ? '/usr/bin/gh' : null,
      readText: async () => null,
      run: async (_binary, args) => {
        runs.push(args.join(' '))
        if (args[1] === 'status') return user ? { code: 0, stdout: '', stderr: `✓ Logged in to github.com account ${user} (keyring)` }
          : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }
        if (args[1] === 'logout') user = null
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  }
  return { runner: new GitHubLoginRunner(ports), children, runs, signIn: (name: string) => { user = name } }
}

it('returns the device code, follows the CLI to signed-in and lets git use the account', async () => {
  const f = fixture()
  const started = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1))
  f.children[0]!.stderr.write('! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n')
  const waiting = await started
  expect(waiting).toMatchObject({ state: 'waiting', code: 'AB12-CD34', verificationUrl: 'https://github.com/login/device' })
  expect(f.children[0]!.args).toEqual(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'])
  expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! })).toMatchObject({ state: 'waiting' })
  f.signIn('octo-owner')
  f.children[0]!.emitter.emit('exit', 0)
  await vi.waitFor(async () => expect(await f.runner.handle({ operation: 'login-status', loginId: waiting.loginId! }))
    .toMatchObject({ state: 'signed-in', account: 'octo-owner', code: null }))
  expect(f.runs).toContain('auth setup-git --hostname github.com')
  expect(await f.runner.handle({ operation: 'logout' })).toMatchObject({ state: 'signed-out', account: null })
  expect(f.runs).toContain('auth logout --hostname github.com --user octo-owner')
})

it('reports a failed sign-in, replaces an earlier one and refuses without the GitHub CLI', async () => {
  const f = fixture()
  const first = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(1))
  f.children[0]!.stdout.write('one-time code: AAAA-1111\n')
  const one = await first
  const second = f.runner.handle({ operation: 'login-start' })
  await vi.waitFor(() => expect(f.children).toHaveLength(2))
  expect(f.children[0]!.kill).toHaveBeenCalled()
  f.children[1]!.stdout.write('one-time code: BBBB-2222\n')
  const two = await second
  await expect(f.runner.handle({ operation: 'login-status', loginId: one.loginId! })).rejects.toMatchObject({ code: 'GITHUB_LOGIN_NOT_FOUND' })
  f.children[1]!.emitter.emit('exit', 1)
  await vi.waitFor(async () => expect(await f.runner.handle({ operation: 'login-status', loginId: two.loginId! }))
    .toMatchObject({ state: 'failed' }))
  await expect(fixture(false).runner.handle({ operation: 'login-start' })).rejects.toMatchObject({ code: 'GITHUB_CLI_MISSING' })
})
