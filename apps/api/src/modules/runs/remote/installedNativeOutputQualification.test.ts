import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexNativeOutputQualificationInput } from '../../harnesses/codexNativeOutput.js'
import type { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import type { CodexNativeSandboxProbePort } from '../../harnesses/qualification/suites/codexNativeOutputSandbox.js'
import type { JsonObject } from '../../harnesses/codexStdioTransport.js'

const recorded = vi.hoisted(() => ({ qualify: vi.fn(), unchanged: vi.fn(), command: vi.fn(), close: vi.fn(),
  checks: vi.fn(), notify: undefined as ((method: string, payload: JsonObject) => void) | undefined,
  emit: true, threadSandbox: {} as JsonObject, environments: [] as NodeJS.ProcessEnv[] }))
vi.mock('../../harnesses/installedCodexDependencies.js', () => ({ createInstalledCodexDependencies: () => ({
  qualify: recorded.qualify, assertUnchanged: recorded.unchanged, runCommand: recorded.command,
}) }))
vi.mock('../../harnesses/qualification/suites/codexNativeOutputSandbox.js', async original => ({
  ...await original<typeof import('../../harnesses/qualification/suites/codexNativeOutputSandbox.js')>(),
  runCodexNativeOutputSandboxChecks: recorded.checks,
}))
vi.mock('../../harnesses/codexStdioTransport.js', async original => ({
  ...await original<typeof import('../../harnesses/codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    constructor(_binary: string, _cwd: string, environment: NodeJS.ProcessEnv, _protocol: unknown,
      _request: unknown, notify: (method: string, params: JsonObject) => void) {
      recorded.environments.push(environment)
      recorded.notify = notify
    }
    async start() {}
    async reject() {}
    async close() { await recorded.close() }
    async request(method: string, params: JsonObject) {
      if (method === 'thread/start') return { cwd: params.cwd, thread: { id: 'diagnostic-thread' }, sandbox: recorded.threadSandbox }
      if (method !== 'turn/start') throw new Error('Unexpected diagnostic method')
      const input = params.input as Array<{ text: string }>
      const command = input[0]!.text.split('then finish: ')[1]!
      if (recorded.emit) {
        const item = { id: 'command-item', type: 'commandExecution', command, status: 'completed', exitCode: 0,
          aggregatedOutput: '{"recorded":true}' }
        recorded.notify!('item/started', { threadId: 'diagnostic-thread', turnId: 'diagnostic-turn', item })
        recorded.notify!('item/completed', { threadId: 'diagnostic-thread', turnId: 'diagnostic-turn', item })
      }
      return { turn: { id: 'diagnostic-turn' } }
    }
  },
}))
import { qualifyInstalledNativeOutputSandbox } from './installedNativeOutputQualification.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
beforeEach(() => {
  vi.resetAllMocks()
  recorded.emit = true
  recorded.environments = []
})

async function fixture() {
  const root = await mkdtemp('/tmp/installed-output-qualification-')
  roots.push(root)
  const cwd = join(root, 'work')
  const protectedDirectory = join(root, 'protected')
  await mkdir(cwd, { mode: 0o700 })
  await mkdir(protectedDirectory, { mode: 0o700 })
  const binary = join(root, 'recorded-binary')
  await writeFile(binary, 'recorded binary, never executed')
  const qualification: CodexNativeOutputQualificationInput = {
    configuration: { harness: 'codex', model: 'recorded', reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard' },
    binary, binaryIdentity: 'original-binary', providerVersion: 'codex-cli 0.154.0', schemaIdentity: 'a'.repeat(64),
    expectedSandbox: { cwd, writableRoots: [], networkAccess: false, excludeSlashTmp: true,
      excludeTmpdirEnvVar: true, tmpdir: undefined },
  }
  recorded.threadSandbox = { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false,
    excludeSlashTmp: true, excludeTmpdirEnvVar: true }
  recorded.qualify.mockResolvedValue({ binary, identity: qualification.binaryIdentity,
    providerVersion: qualification.providerVersion, schemaManifestSha256: qualification.schemaIdentity, protocol: {} })
  recorded.command.mockResolvedValue({ exitCode: 0, stdout: '[{"name":"graphql"}]' })
  const closeOwner = vi.fn(async () => true)
  const registry = { scope: (owner: string) => ({ owner, root: 'recorded-registry' }), closeOwner } as unknown as NativeProcessRegistry
  const input = { qualification, protectedDirectory, registry,
    reader: {} as Parameters<typeof qualifyInstalledNativeOutputSandbox>[0]['reader'], codexSuiteRevision: 'recorded',
    assertCurrent: vi.fn(async () => {}), signal: new AbortController().signal }
  // Recorded native IO and qualification boundaries only. This fixture verifies wiring, never sandbox enforcement.
  recorded.checks.mockImplementation(async ({ probe, signal }: { probe: CodexNativeSandboxProbePort; signal: AbortSignal }) => {
    const policy = await probe.capturePolicy(signal, '/recorded/exact-command')
    const observed = await probe.executeExactCommand('/recorded/exact-command', signal)
    await probe.assertCurrent(signal)
    expect(observed.nativeSessionId).toBe(policy.nativeSessionId)
    expect(observed.nativeTurnId).toBe(policy.nativeTurnId)
    expect(observed.command).toBe('/recorded/exact-command')
    return { checks: [{ id: 'recorded-denial', passed: true }], evidence: {} }
  })
  return { input, closeOwner }
}

describe('installed native output diagnostic wiring', () => {
  it('still closes the original owner when transport cleanup fails', async () => {
    const f = await fixture()
    recorded.close.mockRejectedValue(new Error('Diagnostic transport close failed'))
    await expect(qualifyInstalledNativeOutputSandbox(f.input)).rejects.toThrow('Diagnostic transport close failed')
    expect(f.closeOwner).toHaveBeenCalledOnce()
  })

  it('preserves the qualification error and reports unresolved owner cleanup together', async () => {
    const f = await fixture()
    recorded.checks.mockRejectedValue(new Error('Native sandbox probe failed'))
    f.closeOwner.mockResolvedValue(false)
    const error = await qualifyInstalledNativeOutputSandbox(f.input).catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'Native sandbox probe failed' }),
      expect.objectContaining({ code: 'CODEX_NATIVE_OUTPUT_UNQUALIFIED' }),
    ])
    expect(error.cause).toBe(error.errors[0])
    expect(f.closeOwner).toHaveBeenCalledOnce()
  })

  it('uses a separate owned diagnostic and joins positive closure before returning qualification', async () => {
    const f = await fixture()
    await qualifyInstalledNativeOutputSandbox(f.input)
    expect(recorded.checks).toHaveBeenCalledOnce()
    expect(recorded.unchanged).toHaveBeenCalled()
    expect(recorded.close).toHaveBeenCalledOnce()
    expect(f.closeOwner).toHaveBeenCalledWith(expect.stringMatching(/^qualification:native-output:/))
    expect(recorded.environments[0]?.GRAPHQL_MCP_TOKEN).toBeUndefined()
  })
  it.each(['binary', 'schema', 'sandbox', 'closure', 'denial'] as const)('refuses changed %s qualification', async kind => {
    const f = await fixture()
    if (kind === 'binary') f.input.qualification.binaryIdentity = 'replacement'
    if (kind === 'schema') f.input.qualification.schemaIdentity = 'b'.repeat(64)
    if (kind === 'sandbox') recorded.threadSandbox.writableRoots = [f.input.protectedDirectory]
    if (kind === 'closure') f.closeOwner.mockResolvedValue(false)
    if (kind === 'denial') recorded.checks.mockResolvedValue({ checks: [{ id: 'recorded-denial', passed: false }], evidence: {} })
    await expect(qualifyInstalledNativeOutputSandbox(f.input)).rejects.toMatchObject({ code: 'CODEX_NATIVE_OUTPUT_UNQUALIFIED' })
    expect(f.closeOwner).toHaveBeenCalledOnce()
  })
  it('rejects unmatched command evidence on abort and still closes the diagnostic owner', async () => {
    const f = await fixture()
    recorded.emit = false
    const abort = new AbortController()
    f.input.signal = abort.signal
    recorded.checks.mockImplementationOnce(async ({ probe, signal }: { probe: CodexNativeSandboxProbePort; signal: AbortSignal }) => {
      await probe.capturePolicy(signal, '/recorded/exact-command')
      recorded.notify!('item/completed', { threadId: 'foreign-thread', turnId: 'diagnostic-turn',
        item: { type: 'commandExecution', id: 'forged', command: '/recorded/exact-command' } })
      abort.abort(new Error('No original command evidence'))
      return probe.executeExactCommand('/recorded/exact-command', signal)
    })
    await expect(qualifyInstalledNativeOutputSandbox(f.input)).rejects.toThrow('No original command evidence')
    expect(f.closeOwner).toHaveBeenCalledOnce()
  })
})
