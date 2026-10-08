import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { QualifiedCodex } from './codexProtocol.js'
import { qualifyCodexOutputProtection } from './codexOutputProtection.js'

const provider = vi.hoisted(() => ({ padding: '' }))

vi.mock('./codexProtocol.js', async importOriginal => ({
  ...await importOriginal<typeof import('./codexProtocol.js')>(),
  assertCodexUnchanged: vi.fn(),
}))

vi.mock('./codexStdioTransport.js', async importOriginal => ({
  ...await importOriginal<typeof import('./codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    constructor(...args: unknown[]) {
      this.notify = args[5] as (method: string, params: Record<string, unknown>) => void
    }
    private readonly notify: (method: string, params: Record<string, unknown>) => void
    async start() {}
    async close() {}
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/start') {
        const config = params.config as { sandbox_workspace_write: Record<string, unknown> }
        const policy = config.sandbox_workspace_write
        return { thread: { id: 'probe-thread' }, cwd: params.cwd, sandbox: {
          type: 'workspaceWrite', writableRoots: policy.writable_roots,
          networkAccess: policy.network_access, excludeTmpdirEnvVar: policy.exclude_tmpdir_env_var,
          excludeSlashTmp: policy.exclude_slash_tmp,
        } }
      }
      if (method !== 'turn/start') throw new Error('Unexpected probe request')
      const turn = { id: 'probe-turn', status: 'failed', error: {
        message: `Model unavailable opm_${'a'.repeat(43)}${provider.padding}`, codexErrorInfo: 'modelNotFound',
      } }
      this.notify('turn/completed', { threadId: 'probe-thread', turn })
      return { turn }
    }
  },
}))

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it.each([{ label: 'short', padding: '' }, { label: 'long', padding: 'x'.repeat(4096) }])(
  'reports $label failed turn diagnostics with redaction and closes its owned actor', async ({ padding }) => {
    provider.padding = padding
    const directory = await mkdtemp(join(tmpdir(), 'native-probe-error-'))
    directories.push(directory)
    const workspace = join(directory, 'workspace')
    const protectedDirectory = join(directory, 'private')
    await mkdir(workspace)
    await mkdir(protectedDirectory)
    const recovery = { root: directory, owner: 'probe-owner' }
    const registry = { reserveLaunch: vi.fn(() => recovery), abandonReservedLaunch: vi.fn(),
      closeOwner: vi.fn(async () => true) }
    const qualified = { binary: '/fixture/codex', identity: 'fixture-identity',
      schemaManifestSha256: 'fixture-schema', providerVersion: 'codex-cli 0.154.0',
    } as QualifiedCodex
    const probe = qualifyCodexOutputProtection({ qualification: {
      configuration: { harness: 'codex', model: 'fixture-model', reasoningEffort: 'medium',
        sandbox: 'workspace-write', serviceTier: 'standard' },
      binary: qualified.binary, binaryIdentity: qualified.identity, providerVersion: qualified.providerVersion,
      schemaIdentity: qualified.schemaManifestSha256,
      expectedSandbox: { cwd: workspace, writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: process.env.TMPDIR },
    }, protectedDirectory, registry, qualify: async () => qualified,
    command: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }),
    assertCurrent: async () => {}, signal: new AbortController().signal,
    })
    await expect(probe).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_PROTECTION_FAILED', details: {
      terminalStatus: 'failed',
      terminalError: expect.stringContaining('Model unavailable [REDACTED]'),
      commands: [],
    } })
    if (padding) await expect(probe).rejects.toHaveProperty('details.terminalError.length', 2048)
    expect(registry.abandonReservedLaunch).toHaveBeenCalledWith(recovery)
    expect(registry.closeOwner).toHaveBeenCalledWith(recovery.owner)
  })
