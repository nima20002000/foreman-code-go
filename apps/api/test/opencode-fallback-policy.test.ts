import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

import { OpenCodeAdapter, assertOpenCodeFallbackConfiguration } from '../src/modules/harnesses/opencode.js'
import { advanced, configuration, errorCode, request } from './opencode-fixtures.js'

it('[F01] rejects routed transport before any CLI version, qualification or work is launched', async () => {
  const harness = configuration()
  harness.advanced = advanced()
  await assert.rejects(new OpenCodeAdapter('/must-not-be-launched').qualify(request(harness)), errorCode('OPENCODE_FALLBACK_APPROVAL_UNSUPPORTED'))
})
it('[F02] refuses native auto plus Product permission rules instead of silently ignoring a deny', async () => {
  const harness = configuration()
  harness.autoApprove = true
  harness.advanced = { ...advanced(), permissionHandling: 'native_auto', permissionRules: [{ permission: 'shell', pattern: '*', effect: 'deny' }] }
  await assert.rejects(new OpenCodeAdapter('/must-not-be-launched').qualify(request(harness)), errorCode('OPENCODE_FALLBACK_PERMISSION_RULES_UNSUPPORTED'))
})
it('[F01] the private launch path independently rejects routed settings', async () => {
  const adapter = new OpenCodeAdapter('/must-not-be-launched')
  const direct = adapter as unknown as { run(executionRequest: ReturnType<typeof request>, callbacks: unknown): Promise<unknown> }
  await assert.rejects(direct.run(request(), { signal: new AbortController().signal, onEvent: async () => undefined, onSession: async () => undefined }), errorCode('OPENCODE_FALLBACK_APPROVAL_UNSUPPORTED'))
})
it('[F02] native auto without Product rules remains an explicit supported fallback', () => {
  assert.doesNotThrow(() => assertOpenCodeFallbackConfiguration({ ...configuration(), autoApprove: true }))
})
it.skipIf(process.platform === 'win32')('[F01,F02] warning-only CLI permissions cannot bypass prelaunch validation or execute denied work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphql-opencode-fallback-policy-'))
  const marker = join(directory, 'launched')
  const binary = join(directory, 'native-behavior.cjs')
  await writeFile(binary, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched');
// OpenCode 1.18.31 handles permission.asked internally, printing a warning and
// rejecting it outside auto mode; it does not emit that JSON permission event.
console.error('Warning: permission request rejected in noninteractive run');
console.log(JSON.stringify({type:'text',part:{text:'request rejected'}}));
`, { mode: 0o700 })
  try {
    for (const auto of [false, true]) {
      const harness = configuration()
      harness.autoApprove = auto
      harness.advanced = { ...advanced(), permissionHandling: auto ? 'native_auto' : 'graphql_routed',
        permissionRules: auto ? [{ permission: 'shell', pattern: '*', effect: 'deny' }] : [] }
      await assert.rejects(new OpenCodeAdapter(binary).execute({ ...request(harness), workingDirectory: directory }, {
        signal: new AbortController().signal, onSession: async () => undefined, onEvent: async () => undefined,
      }), errorCode(auto ? 'OPENCODE_FALLBACK_PERMISSION_RULES_UNSUPPORTED' : 'OPENCODE_FALLBACK_APPROVAL_UNSUPPORTED'))
      await assert.rejects(readFile(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
