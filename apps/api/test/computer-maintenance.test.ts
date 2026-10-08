import { describe, expect, it } from 'vitest'
import { ComputerMaintenance, type MaintenancePorts } from '../src/modules/computers/maintenance.js'
import { syncableServers } from '../src/modules/computers/fleet.js'

type Run = { binary: string; args: string[] }
function ports(overrides: { versions?: Record<string, string | null>; sudo?: boolean; apt?: string; files?: Record<string, string>;
  codexMcp?: string[]; oauthMcp?: string[]; plugins?: string[]; marketplaces?: string[]; fail?: (run: Run) => boolean } = {}) {
  const marketplaces = [...overrides.marketplaces ?? ['openai']], plugins = [...overrides.plugins ?? []]
  const codexMcp = [...overrides.codexMcp ?? []]
  const runs: Run[] = []
  const later: Array<() => void> = []
  const versions: Record<string, string | null> = { codex: 'codex-cli 0.160.0', claude: '2.1.19 (Claude Code)', ...overrides.versions }
  const value: MaintenancePorts = {
    environment: { HOME: '/home/owner' },
    find: async name => name in versions && versions[name] === null ? null : ['codex', 'claude', 'npm', 'apt-get'].includes(name) ? `/usr/bin/${name}` : null,
    run: async (binary, args) => {
      runs.push({ binary, args })
      if (overrides.fail?.({ binary, args })) return { code: 1, stdout: '', stderr: 'boom' }
      const name = binary.split('/').at(-1)!
      if (args[0] === '--version') return { code: 0, stdout: versions[name] ?? '', stderr: '' }
      if (name === 'npm' && args[0] === 'view') return { code: 0, stdout: args[1] === '@openai/codex' ? '0.161.0\n' : '2.1.294\n', stderr: '' }
      if (name === 'npm' && args[0] === 'install') { versions.codex = 'codex-cli 0.161.0'; return { code: 0, stdout: 'added 1 package', stderr: '' } }
      if (name === 'claude' && args[0] === 'update') { versions.claude = '2.1.294 (Claude Code)'; return { code: 0, stdout: 'updated', stderr: '' } }
      if (name === 'apt-get') return { code: 0, stdout: overrides.apt ?? 'Inst libc6 [1]\nInst curl [2]\n', stderr: '' }
      if (binary === 'sudo' && args[1] === 'true') return { code: overrides.sudo === false ? 1 : 0, stdout: '', stderr: '' }
      if (binary === 'sudo' && args.includes('upgrade')) return { code: 0, stdout: '2 upgraded, 0 newly installed', stderr: '' }
      if (name === 'codex' && args[0] === 'mcp' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(codexMcp.map(name => ({ name }))), stderr: '' }
      if (name === 'codex' && args[0] === 'mcp' && args[1] === 'add') {
        codexMcp.push(args[2]!)
        // Codex saves an OAuth server, then fails when nobody completes the browser sign-in.
        if (overrides.oauthMcp?.includes(args[2]!)) return { code: 1, stdout: 'Added global MCP server.\nDetected OAuth support.', stderr: 'timed out waiting for OAuth callback' }
      }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'list') return { code: 0, stdout: JSON.stringify({ installed: plugins.map(pluginId => ({ pluginId, installed: true })) }), stderr: '' }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'marketplace') {
        if (args[2] === 'list') return { code: 0, stdout: JSON.stringify({ marketplaces: marketplaces.map(name => ({ name, marketplaceSource: { sourceType: 'git', source: name } })) }), stderr: '' }
        marketplaces.push(args[3]!.split('/').at(-1)!.replace(/\.git$/u, ''))
        return { code: 0, stdout: '', stderr: '' }
      }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'add') {
        if (!marketplaces.includes(args[2]!.split('@')[1]!)) return { code: 1, stdout: '', stderr: 'plugin was not found in marketplace' }
        plugins.push(args[2]!)
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: async path => path === '/var/run/reboot-required' && Boolean(overrides.files?.[path]),
    readText: async path => overrides.files?.[path] ?? null,
    disk: async () => ({ freeBytes: 50, totalBytes: 100 }),
    later: fn => { later.push(fn) },
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  }
  return { value, runs, later }
}
async function settle(maintenance: ComputerMaintenance) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await maintenance.status(AbortSignal.timeout(1000))
    if (status.tasks.every(task => task.state !== 'running')) return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish')
}

describe('computer maintenance', () => {
  it('reports harness versions against the latest release, OS updates, restart, sudo and disk', async () => {
    const fake = ports({ files: { '/var/run/reboot-required': '1' } })
    const status = await new ComputerMaintenance(fake.value).status(AbortSignal.timeout(1000))
    expect(status.harnesses).toEqual([
      { harness: 'codex', installed: true, version: '0.160.0', latest: '0.161.0' },
      { harness: 'claude', installed: true, version: '2.1.19', latest: '2.1.294' },
    ])
    expect(status.system).toEqual({ packageUpdates: 2, rebootRequired: true, sudo: true, disk: { path: '/home/owner', freeBytes: 50, totalBytes: 100 } })
  })

  it('updates Codex through npm in the user prefix and Claude through its own updater', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    expect(maintenance.start({ kind: 'update-harnesses', harnesses: ['codex', 'claude'] }).state).toBe('running')
    const status = await settle(maintenance)
    expect(status.tasks[0]).toMatchObject({ kind: 'update-harnesses', state: 'succeeded', summary: 'Codex 0.160.0 → 0.161.0 · Claude 2.1.19 → 2.1.294' })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/npm', args: ['install', '--global', '--prefix', '/home/owner/.local', '@openai/codex@latest'] })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/claude', args: ['update'] })
  })

  it('runs a non-interactive sudo apt upgrade and refuses OS work without passwordless sudo', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    maintenance.start({ kind: 'update-system' })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: '2 packages upgraded' })
    const upgrade = fake.runs.find(run => run.binary === 'sudo' && run.args.includes('upgrade'))!
    expect(upgrade.args).toEqual(expect.arrayContaining(['-n', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-y', 'Dpkg::Options::=--force-confold']))
    const locked = new ComputerMaintenance(ports({ sudo: false }).value)
    locked.start({ kind: 'restart' })
    expect((await settle(locked)).tasks[0]).toMatchObject({ state: 'failed', summary: 'This computer needs passwordless sudo for OS updates and restarts.' })
  })

  it('answers before restarting and never starts the same kind twice at once', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    const first = maintenance.start({ kind: 'restart' })
    expect(maintenance.start({ kind: 'restart' }).id).toBe(first.id)
    await settle(maintenance)
    expect(fake.runs.some(run => run.args.includes('reboot'))).toBe(false)
    fake.later.forEach(run => run())
    expect(fake.runs).toContainEqual({ binary: 'sudo', args: ['-n', 'systemctl', 'reboot'] })
  })

  it('adds only missing MCP servers and plugins and skips a harness that is not installed', async () => {
    const fake = ports({ versions: { claude: null }, codexMcp: ['docs'], plugins: ['pdf@openai'] })
    const maintenance = new ComputerMaintenance(fake.value)
    maintenance.start({ kind: 'sync-mcp', servers: {
      codex: [{ transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null },
        { transport: 'stdio', name: 'search', command: 'npx', args: ['search-mcp'], envVars: [] }],
      claude: [{ transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }] } })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Codex: Added search · Claude: not installed, skipped' })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/codex', args: ['mcp', 'add', 'search', '--', 'npx', 'search-mcp'] })
    maintenance.start({ kind: 'sync-plugins', plugins: ['pdf@openai', 'documents@openai'], marketplaces: [] })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Installed documents@openai' })
  })

  it('adds a missing Git marketplace before its plugins, and one plugin that cannot install does not stop the others', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    maintenance.start({ kind: 'sync-plugins', plugins: ['skill-creator@claude-plugins-official', 'lost@elsewhere', 'pdf@openai'],
      marketplaces: [{ name: 'claude-plugins-official', source: 'https://github.com/anthropics/claude-plugins-official.git' }] })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'failed',
      summary: 'Installed skill-creator@claude-plugins-official, pdf@openai · Could not install lost@elsewhere' })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/codex', args: ['plugin', 'marketplace', 'add', 'https://github.com/anthropics/claude-plugins-official.git'] })
  })
})

describe('fleet MCP sync with OAuth servers', () => {
  it('keeps an OAuth server that Codex saved, continues with the rest, and asks for sign-in on that computer', async () => {
    const fake = ports({ versions: { claude: null }, oauthMcp: ['linear'] })
    const maintenance = new ComputerMaintenance(fake.value)
    maintenance.start({ kind: 'sync-mcp', servers: {
      codex: [{ transport: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: null },
        { transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }], claude: [] } })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Codex: Added linear (sign in on this computer), docs' })
  })

  it('fails when Codex could not save the server', async () => {
    const fake = ports({ fail: run => run.args[1] === 'add' })
    const maintenance = new ComputerMaintenance(fake.value)
    maintenance.start({ kind: 'sync-mcp', servers: { codex: [{ transport: 'stdio', name: 'search', command: 'npx', args: ['search-mcp'], envVars: [] }], claude: [] } })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'failed', summary: 'codex mcp add search failed.' })
  })
})

describe('fleet MCP sync source', () => {
  it('copies servers without inline secrets and never the app MCP', () => {
    expect(syncableServers({
      'foreman-code': { command: 'foreman-mcp' }, graphql: { url: 'http://127.0.0.1:3000/mcp' },
      linear: { url: 'https://mcp.linear.app/mcp', bearer_token_env_var: 'LINEAR_TOKEN' },
      search: { command: 'npx', args: ['search-mcp'] },
      secret: { command: 'npx', args: ['x'], env: { API_KEY: 'value' } },
      claude: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
    })).toEqual([
      { transport: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: 'LINEAR_TOKEN' },
      { transport: 'stdio', name: 'search', command: 'npx', args: ['search-mcp'], envVars: [] },
    ])
  })
})
