import { expect, it } from 'vitest'
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
  const result = await probeComputerAccounts(ports(['codex', 'claude', 'opencode', 'gh', 'rclone'], {
    'claude auth status': { stdout: JSON.stringify({ loggedIn: true, email: 'claude@example.com', authMethod: 'claude.ai' }) },
    'opencode auth list': { stdout: '\u001b[0m┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenCode Go \u001b[90mapi\n│\n●  OpenRouter api\n└  2 credentials' },
    'gh auth status --hostname github.com': { stderr: 'github.com\n  ✓ Logged in to github.com account octo-owner (keyring)\n  - Token: gho_****' },
    'rclone listremotes --long': { stdout: 'shared:  drive\nphotos: s3\n' },
    'rclone config userinfo shared: --json': { stdout: JSON.stringify({ Email: 'drive@example.com' }) },
  }, { '/home/agent/.codex/auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token({ email: 'codex@example.com' }), refresh_token: 'secret' } }) }))
  expect(result.accounts).toEqual([
    { tool: 'codex', installed: true, signedIn: true, account: 'codex@example.com', details: ['ChatGPT'] },
    { tool: 'claude', installed: true, signedIn: true, account: 'claude@example.com', details: ['claude.ai'] },
    { tool: 'opencode', installed: true, signedIn: true, account: null, details: ['OpenCode Go', 'OpenRouter'] },
    { tool: 'github', installed: true, signedIn: true, account: 'octo-owner', details: [] },
    { tool: 'drive', installed: true, signedIn: true, account: 'drive@example.com', details: ['shared:'] },
  ])
  expect(JSON.stringify(result)).not.toMatch(/secret|gho_/)
})

it('separates missing tools, signed-out tools and unreadable sign-in state', async () => {
  const signedOut = await probeComputerAccounts(ports(['claude'], {
    'claude auth status': { code: 1, stdout: 'Invalid API key · Please run /login' } }))
  expect(signedOut.accounts.find(value => value.tool === 'claude')?.signedIn).toBe(false)
  const result = await probeComputerAccounts(ports(['codex', 'claude', 'gh', 'rclone'], {
    'claude auth status': { stdout: 'not json' },
    'gh auth status --hostname github.com': { code: 1, stderr: 'You are not logged into any GitHub hosts.' },
    'rclone listremotes --long': { stdout: '' },
  }))
  expect(result.accounts.map(value => [value.tool, value.installed, value.signedIn])).toEqual([
    ['codex', true, false], ['claude', true, null], ['opencode', false, null], ['github', true, false], ['drive', true, false],
  ])
})

it('prefers the app Drive remote and reports where it is mounted', async () => {
  const result = await probeComputerAccounts(ports(['rclone'], {
    'rclone listremotes --long': { stdout: 'shared:  drive\nforeman-drive: drive\n' },
    'rclone config userinfo foreman-drive: --json': { stdout: JSON.stringify({ Email: 'owner@gmail.com' }) },
  }, { '/proc/self/mountinfo': '1 2 0:1 / / rw - ext4 /dev/sda1 rw\n90 1 0:55 / /home/agent/Foreman\\040Code\\040Drive rw - fuse.rclone foreman-drive: rw\n' }))
  expect(result.accounts.find(account => account.tool === 'drive')).toEqual({ tool: 'drive', installed: true, signedIn: true,
    account: 'owner@gmail.com', details: ['foreman-drive:', 'mount:/home/agent/Foreman Code Drive'] })
})

it('reports an installed Claude that cannot start', async () => {
  const result = await probeComputerAccounts({ ...ports(['claude'], {}),
    run: async () => ({ code: null, stdout: '', stderr: '' }) })
  expect(result.accounts.find(account => account.tool === 'claude')).toEqual({ tool: 'claude', installed: true, signedIn: null,
    account: null, details: ['cannot start'] })
})

it('reads the Drive account the app recorded when rclone cannot report it', async () => {
  const result = await probeComputerAccounts(ports(['rclone'], {
    'rclone listremotes --long': { stdout: 'foreman-drive: drive\n' },
    'rclone config userinfo foreman-drive: --json': { code: 1, stderr: "Google drive root '' doesn't support UserInfo" },
  }, { '/home/agent/.config/rclone/rclone.conf': '[foreman-drive]\ndescription = owner@gmail.com\ntype = drive\ntoken = {"access_token":"secret"}\n' }))
  expect(result.accounts.find(account => account.tool === 'drive')).toEqual({ tool: 'drive', installed: true, signedIn: true,
    account: 'owner@gmail.com', details: ['foreman-drive:'] })
  expect(JSON.stringify(result)).not.toContain('secret')
})
