import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import type { QualificationSuite } from './types.js'
import { HarnessQualificationService } from './service.js'

it.each(['binary', 'payload'] as const)(
  'waits for an older flight and runs the suite for a changed %s installation identity', async change => {
    let installation = 'A'
    const originalSha = 'a'.repeat(64)
    const updatedSha = change === 'binary' ? 'b'.repeat(64) : originalSha
    const records = new Map<string, HarnessQualification>()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const running = new Promise<void>(resolve => { entered = resolve })
    let inspected!: () => void
    const inspectedUpdate = new Promise<void>(resolve => { inspected = resolve })
    const suites: string[] = []
    const run = vi.fn<QualificationSuite['run']>(async () => {
      suites.push(installation)
      if (installation === 'A') { entered(); await held }
      return { checks: [{ id: 'native-turn', passed: true, detail: null }], evidence: {} }
    })
    const service = new HarnessQualificationService({
      find: async (_harness: unknown, _version: unknown, sha: string) => records.get(sha) ?? null,
      save: async (record: HarnessQualification) => { records.set(record.binarySha256!, structuredClone(record)) },
    } as never, {
      inspectBinary: async () => {
        if (installation === 'B') inspected()
        return { binary: '/installed/codex', sha256: installation === 'A' ? originalSha : updatedSha }
      },
      trusted: async () => true,
    } as never, { codex: { harness: 'codex', revision: 'native-suite', run } },
    { codex: '/installed/codex' }, {} as never,
    { getManagedHarnessDefaults: async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }) },
    async () => 'schema', undefined, (_harness, binary) => ({
      inspect: async () => ({ executable: binary, identity: installation, version: '0.156.1' }),
      probe: async () => 'schema', assertUnchanged: async () => {}, close: async () => {},
    }), undefined, () => installation)
    let recovery: Promise<HarnessQualification> | undefined
    try {
      await service.begin('codex', true)
      await running
      installation = 'B'
      recovery = service.verify('codex', { force: true })
      await inspectedUpdate
      expect(suites).toEqual(['A'])
      release()
      const result = await recovery
      expect(suites).toEqual(['A', 'B'])
      expect(result).toMatchObject({ binarySha256: updatedSha, status: 'qualified', suiteRevision: 'native-suite' })
      expect(records.get(updatedSha)).toEqual(result)
    } finally {
      release()
      if (recovery) await recovery
      await service.shutdown()
    }
  },
)
