import { expect, it, vi } from 'vitest'
import { probeComputerAccounts, type AccountProbePorts } from './accountProbe.js'

const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
function ports(installed: string[], outputs: Record<string, { code?: number; stdout?: string; stderr?: string }>,
  files: Record<string, string> = {}): AccountProbePorts {
  return {
    environment: { HOME: '/home/agent' },
    find: async name => installed.includes(name) ? `/usr/bin/${name}` : null,
    run: async (binary, args) => ({ code: 0, stdout: '', stderr: '', ...outputs[`${binary.split('/').at(-1)} ${args.join(' ')}`] }),
    readText: async path => files[path] ?? null,
  }
}

it('reads each tool account without exposing tokens', async () => {
  const result = await probeComputerAccounts(ports(['codex', 'claude', 'gh'], {
    'claude auth status': { stdout: JSON.stringify({ loggedIn: true, email: 'claude@example.com', authMethod: 'claude.ai' }) },
    'gh auth status --active --hostname github.com --json hosts': { stdout: JSON.stringify({ hosts: { 'github.com': [{ login: 'octo-owner', active: true, state: 'success' }] } }) },
  }, { '/home/agent/.codex/auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token({ email: 'codex@example.com' }), refresh_token: 'secret' } }) }))
  expect(result.accounts).toEqual([
    { tool: 'codex', installed: true, signedIn: true, account: 'codex@example.com', details: ['ChatGPT'] },
    { tool: 'claude', installed: true, signedIn: true, account: 'claude@example.com', details: ['claude.ai'] },
    { tool: 'github', installed: true, signedIn: true, account: 'octo-owner', details: [] },
  ])
  expect(JSON.stringify(result)).not.toMatch(/secret|gho_/)
})

it('separates missing tools, signed-out tools and unreadable sign-in state', async () => {
  const signedOut = await probeComputerAccounts(ports(['claude'], {
    'claude auth status': { code: 1, stdout: 'Invalid API key · Please run /login' } }))
  expect(signedOut.accounts.find(value => value.tool === 'claude')?.signedIn).toBe(false)
  const result = await probeComputerAccounts(ports(['codex', 'claude', 'gh'], {
    'claude auth status': { stdout: 'not json' },
    'gh auth status --active --hostname github.com --json hosts': { code: 1, stderr: 'You are not logged into any GitHub hosts.' },
  }))
  expect(result.accounts.map(value => [value.tool, value.installed, value.signedIn])).toEqual([
    ['codex', true, null], ['claude', true, null], ['github', true, false],
  ])
})

it.each(['missing', 'unreadable', 'malformed'] as const)(
  'keeps installed Codex sign-in unknown when its auth file is %s', async state => {
    const run = vi.fn<AccountProbePorts['run']>()
    const result = await probeComputerAccounts({
      ...ports(['codex'], {}),
      run,
      readText: async () => {
        if (state === 'unreadable') throw new Error('Access denied')
        return state === 'missing' ? null : 'not json'
      },
    })
    expect(result.accounts.find(account => account.tool === 'codex')).toEqual({
      tool: 'codex', installed: true, signedIn: null, account: null, details: [],
    })
    expect(run).not.toHaveBeenCalled()
  },
)

it('distinguishes unavailable Codex from an installed tool with unknown sign-in', async () => {
  const result = await probeComputerAccounts(ports([], {}))
  expect(result.accounts.find(account => account.tool === 'codex')).toEqual({
    tool: 'codex', installed: false, signedIn: null, account: null, details: [],
  })
})

it('reports an installed Claude that cannot start', async () => {
  const result = await probeComputerAccounts({ ...ports(['claude'], {}),
    run: async () => ({ code: null, stdout: '', stderr: '' }) })
  expect(result.accounts.find(account => account.tool === 'claude')).toEqual({ tool: 'claude', installed: true, signedIn: null,
    account: null, details: ['cannot start'] })
})



it('chooses the active GitHub account from structured status', async () => {
  const result = await probeComputerAccounts(ports(['gh'], {
    'gh auth status --active --hostname github.com --json hosts': { stdout: JSON.stringify({ hosts: { 'github.com': [
      { login: 'inactive', active: false, state: 'success' },
      { login: 'active-owner', active: true, state: 'success' },
    ] } }) },
  }))
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: true, account: 'active-owner' })
})

it.each([
  { code: null, stdout: '', stderr: '' },
  { code: 1, stdout: '', stderr: 'network timeout' },
  { code: 0, stdout: 'unreadable', stderr: '' },
  { code: 0, stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'owner', state: 'timeout' }] } }), stderr: '' },
])('keeps failed or unreadable GitHub status unknown', async output => {
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async () => output })
  expect(result.accounts.find(value => value.tool === 'github')?.signedIn).toBeNull()
})

it('uses text status when JSON is unsupported and selects the active account', async () => {
  const calls: string[][] = []
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async (_binary, args) => {
    calls.push(args)
    if (args.includes('--json')) return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
    return { code: 0, stdout: '', stderr: '✓ Logged in to github.com account inactive (keyring)\n - Active account: false\n'
      + '✓ Logged in to github.com account active-owner (keyring)\n - Active account: true\n' }
  } })
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: true, account: 'active-owner' })
  expect(calls[1]).toEqual(['auth', 'status', '--active', '--hostname', 'github.com'])
})

it('supports a single account on old GitHub CLI releases without active or JSON flags', async () => {
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async (_binary, args) => {
    if (args.includes('--active')) return { code: 1, stdout: '', stderr: 'unknown flag: --active' }
    return { code: 0, stdout: '', stderr: '✓ Logged in to github.com account old-owner (keyring)' }
  } })
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: true, account: 'old-owner' })
})

it.each([true, false])('reports GitHub signed-out with another host configured and active support %s', async supportsActive => {
  const result = await probeComputerAccounts({ ...ports(['gh'], {}), run: async (_binary, args) => {
    if (args.includes('--json')) return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
    if (!supportsActive && args.includes('--active')) return { code: 1, stdout: '', stderr: 'unknown flag: --active' }
    return { code: 1, stdout: '', stderr: 'You are not logged into any accounts on github.com' }
  } })
  expect(result.accounts.find(value => value.tool === 'github')).toMatchObject({ signedIn: false, account: null })
})
