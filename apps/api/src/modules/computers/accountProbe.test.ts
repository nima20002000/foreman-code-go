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
  const result = await probeComputerAccounts(ports(['codex', 'claude', 'gh', 'rclone'], {
    'claude auth status': { stdout: 'not json' },
    'gh auth status --hostname github.com': { code: 1, stderr: 'You are not logged into any GitHub hosts.' },
    'rclone listremotes --long': { stdout: '' },
  }))
  expect(result.accounts.map(value => [value.tool, value.installed, value.signedIn])).toEqual([
    ['codex', true, false], ['claude', true, null], ['opencode', false, null], ['github', true, false], ['drive', true, false],
  ])
})
