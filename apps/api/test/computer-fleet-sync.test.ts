import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaintenanceRequestSchema } from '@foreman-code/contracts/computer-maintenance'
import { ComputerMaintenance, systemMaintenancePorts } from '../src/modules/computers/maintenance.js'
import { syncableServers } from '../src/modules/computers/fleet.js'
import { fakeComputer, fakeFleet, server, settle } from './helpers/fleetSync.js'

describe('fleet source propagation', () => {
  it('distinguishes an absent native catalog from a failed file read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-source-'))
    const ports = systemMaintenancePorts()
    try {
      expect(await ports.readText(join(directory, 'missing.json'))).toBeNull()
      await expect(ports.readText(directory)).rejects.toMatchObject({ code: 'EISDIR' })
      const file = join(directory, 'catalog.json')
      await writeFile(file, '{}')
      expect(await ports.readText(file)).toBe('{}')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('skips and reports inline credentials without passing them to receiver commands', async () => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    sources.codexUserMcpServers = async () => ({
      safe: { url: 'https://service.example/mcp', bearer_token_env_var: 'SERVICE_TOKEN' },
      query: { url: 'https://service.example/mcp?api_key=fixture-secret' },
      userinfo: { url: 'https://owner:fixture-secret@service.example/mcp' },
      argument: { command: '/usr/bin/server', args: ['--api-key=fixture-secret'] },
      separate: { command: '/usr/bin/server', args: ['--api-key', 'fixture-secret'] },
      bearer: { command: '/usr/bin/server', args: ['Authorization: Bearer fixture-secret'] },
    })
    await fleet.syncChangedSources()
    const status = await settle(computer)
    expect([...computer.codexMcp]).toEqual(['safe'])
    expect(JSON.stringify(requested)).not.toContain('fixture-secret')
    expect(JSON.stringify(computer.calls)).not.toContain('fixture-secret')
    const summary = status.tasks.find(task => task.kind === 'sync-mcp')?.summary
    for (const name of ['query', 'userinfo', 'argument', 'separate', 'bearer']) expect(summary).toContain(name)
    expect(syncableServers({ tool: { command: 'npx', args: ['server', '--token-env-var', 'SERVICE_TOKEN'] } }))
      .toHaveLength(1)
  })

  it.each(['codex', 'claude'] as const)('preserves %s MCP when its source is unreadable', async harness => {
    const computer = fakeComputer()
    const { fleet, sources } = fakeFleet(computer)
    sources.claudeUserMcpServers = async () => ({ docs: { url: 'https://docs.example/mcp' } })
    await fleet.syncChangedSources()
    await settle(computer)
    sources.codexUserMcpServers = async () => ({})
    sources.claudeUserMcpServers = async () => ({})
    sources[`${harness}UserMcpServers`] = async () => { throw new Error('Native discovery timeout') }
    await fleet.syncChangedSources()
    const status = await settle(computer)
    expect(computer.codexMcp.has('docs')).toBe(harness === 'codex')
    expect(computer.claudeMcp.has('docs')).toBe(harness === 'claude')
    expect(status.tasks[0]?.summary).toContain('could not be read')
    sources[`${harness}UserMcpServers`] = async () => ({})
    await fleet.syncChangedSources()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual([])
    expect([...computer.claudeMcp]).toEqual([])
  })

  it.each(['codex', 'claude'] as const)('preserves %s plugins when its source is unreadable', async harness => {
    const computer = fakeComputer()
    const { fleet, sources } = fakeFleet(computer)
    sources.codexPlugins = async () => ['notes@official']
    sources.claudePlugins = async () => ({ plugins: [{ pluginId: 'notes@official', installed: true,
      enabled: true, name: 'notes', marketplaceName: 'official', description: null,
      version: null, installCount: null }], marketplaces: [] })
    await fleet.syncChangedSources()
    await settle(computer)
    sources.codexPlugins = async () => []
    sources.claudePlugins = async () => ({ plugins: [], marketplaces: [] })
    if (harness === 'codex') sources.codexPlugins = async () => { throw new Error('Catalog unavailable') }
    else sources.claudePlugins = async () => { throw new Error('Catalog unavailable') }
    await fleet.syncChangedSources()
    const status = await settle(computer)
    expect(computer.codexPlugins.has('notes@official')).toBe(harness === 'codex')
    expect(computer.claudePlugins.has('notes@official')).toBe(harness === 'claude')
    expect(status.tasks.find(task => task.kind === 'sync-plugins')?.summary).toContain('could not be read')
  })

  it('retries failed background work with unchanged sources on the next tick', async () => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    sources.codexPlugins = async () => ['notes@official']
    computer.fail((binary, args) => binary.endsWith('codex') && args[0] === 'plugin' && args[1] === 'add')
    await fleet.syncChangedSources()
    expect((await settle(computer)).tasks.find(task => task.kind === 'sync-plugins')?.state).toBe('failed')
    computer.fail(() => false)
    await fleet.syncChangedSources()
    await settle(computer)
    expect([...computer.codexPlugins]).toEqual(['notes@official'])
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(1)
    expect(requested.filter(task => task.kind === 'sync-plugins')).toHaveLength(2)
    await fleet.syncChangedSources()
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(3)
  })

  it('waits for matching completion and retries an interrupted Worker task', async () => {
    const computer = fakeComputer()
    const originalRead = computer.ports.readText
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    computer.ports.readText = async path => {
      if (path.endsWith('fleet-sync.json')) await gate
      return originalRead(path)
    }
    const { fleet, requested } = fakeFleet(computer)
    await fleet.syncChangedSources()
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(2)
    const original = computer.maintenance
    computer.maintenance = new ComputerMaintenance(computer.ports)
    await fleet.syncChangedSources()
    expect(requested).toHaveLength(4)
    release()
    await settle({ ...computer, maintenance: original })
    await settle(computer)
  })

  it('does not acknowledge an older source task, even with a fast receiver clock', async () => {
    const computer = fakeComputer()
    computer.ports.now = () => new Date('2099-01-01T00:00:00.000Z')
    const originalRead = computer.ports.readText
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    computer.ports.readText = async path => {
      if (path.endsWith('fleet-sync.json')) await gate
      return originalRead(path)
    }
    const older = await computer.maintenance.start({ kind: 'sync-mcp', servers: { codex: [server('old')], claude: [] } })
    const { fleet, requested, endpoint } = fakeFleet(computer)
    const workerRequest = endpoint.request
    // An older receiver reply must not acknowledge Main's current sources.
    endpoint.request = async (device, namespace, payload) => {
      const request = MaintenanceRequestSchema.parse(payload)
      if (request.operation === 'start' && request.task.kind === 'sync-mcp') {
        requested.push(request.task)
        return { payload: { operation: 'start', task: older } }
      }
      return workerRequest(device, namespace, payload)
    }
    await fleet.syncChangedSources()
    endpoint.request = workerRequest
    release()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual(['old'])
    await fleet.syncChangedSources()
    await settle(computer)
    expect([...computer.codexMcp]).toEqual(['docs'])
    expect(requested.filter(task => task.kind === 'sync-mcp')).toHaveLength(2)
  })

  it.each(['mcp', 'plugins'] as const)('propagates other catalogs when all %s sources fail', async kind => {
    const computer = fakeComputer()
    const { fleet, sources, requested } = fakeFleet(computer)
    if (kind === 'plugins') {
      sources.codexPlugins = async () => { throw new Error('Plugin discovery timeout') }
      sources.claudePlugins = async () => { throw new Error('Plugin discovery timeout') }
    } else {
      sources.codexUserMcpServers = async () => { throw new Error('MCP discovery timeout') }
      sources.claudeUserMcpServers = async () => { throw new Error('MCP discovery timeout') }
      sources.codexPlugins = async () => ['notes@official']
    }
    await expect(fleet.syncChangedSources()).rejects.toThrow('Some fleet settings could not be read')
    await settle(computer)
    expect(requested.map(task => task.kind)).toEqual([kind === 'plugins' ? 'sync-mcp' : 'sync-plugins'])
    if (kind === 'plugins') expect([...computer.codexMcp]).toEqual(['docs'])
    else expect([...computer.codexPlugins]).toEqual(['notes@official'])
  })
})
