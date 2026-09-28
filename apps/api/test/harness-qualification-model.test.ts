import { strict as assert } from 'node:assert'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import type { QualificationSuiteInput } from '../src/modules/harnesses/qualification/types.js'

it.skipIf(process.platform === 'win32')('passes each saved harness model to the live qualification suite, or null when unsaved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-model-'))
  try {
    for (const [harness, revision, expected] of [
      ['codex', 0, null], ['codex', 1, 'saved-codex-model'], ['opencode', 1, 'saved-opencode-model'],
    ] as const) {
      const binary = join(directory, `fake-${harness}`)
      await writeFile(binary, `#!/bin/sh\necho "${harness === 'codex' ? 'codex-cli ' : ''}0.158.0"\n`)
      await chmod(binary, 0o700)
      const run = vi.fn(async (input: QualificationSuiteInput) => ({ checks: [{ id: 'live', passed: true, detail: null }], evidence: { model: input.model } }))
      const save = vi.fn(async () => undefined)
      const service = new HarnessQualificationService(
        { find: async () => undefined, save } as unknown as ConstructorParameters<typeof HarnessQualificationService>[0],
        { inspectBinary: async () => ({ binary, sha256: 'a'.repeat(64) }), trusted: async () => true } as unknown as ConstructorParameters<typeof HarnessQualificationService>[1],
        { codex: { harness: 'codex', revision: 'test', run }, opencode: { harness: 'opencode', revision: 'test', run } },
        { codex: binary, opencode: binary },
        {} as ConstructorParameters<typeof HarnessQualificationService>[4],
        { getManagedHarnessDefaults: async () => ({ revision,
          defaults: { codex: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'saved-codex-model' },
            opencode: { ...DEFAULT_HARNESS_DEFAULTS.opencode, model: 'saved-opencode-model' } },
        }) },
        async () => 'static',
      )
      await service.begin(harness)
      await vi.waitFor(() => assert.equal(save.mock.calls.length, 2))
      assert.equal(run.mock.calls.length, 1)
      assert.equal(run.mock.calls[0]?.[0].model, expected)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
